import ora from "ora";
import chalk from "chalk";
import { globalTokenTracker } from "../cost/token-tracker.js";
import { globalCostCalculator } from "../cost/cost-calculator.js";
import { DelegationGuard } from "./delegation-guard.js";
import { createSecondLLMProvider } from "../providers/provider-factory.js";
import { LLMLogger } from "../agent/llm-logger.js";
import { getOpsLogger } from "../utils/ops-logger.js";
import {
  HarnessState,
  enrichToolResult,
  buildSubAgentStrategyPrompt,
} from "../agent/harness-intervention.js";
import type { SecondLLMConfig, SecondLLMEndpoint } from "../config/types.js";
import type { LLMProvider, Message, ToolCall } from "../providers/base-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { PermissionManager } from "../security/permission-manager.js";

const EXCLUDED_TOOLS = [
  "task",
  "task_output",
  "second_llm_consult", // avoid recursive calls
  "second_llm_agent",
  "enter_plan_mode",
  "exit_plan_mode"
];

/** Evaluatorに許可する読み取り専用ツール */
const EVALUATOR_ALLOWED_TOOLS = [
  "file_read",
  "grep",
  "glob",
];

// ─── サンプリング・ループ上限の既定値 (ID-020 / ID-021: 2026-04-30 切り出し) ───
//
// 優先順位:
//   1. endpoint.temperature 等 (ユーザーが /second temperature で設定した値)
//   2. config.secondLLM.samplingDefaults (config.json で用途別に指定された値)
//   3. 下記ハードコード fallback (後方互換のため残す)
//
// 用途別の既定温度:
//   - consult / runAsAgent: 0.2 (バランス: 多少の創造性 + ある程度の決定性)
//   - runAsEvaluator: 0.1 (決定論寄り、 評価結果の再現性確保)

/** consult (単発相談) のハードコード fallback 温度 */
const DEFAULT_TEMPERATURE_CONSULT = 0.2;
/** runAsAgent (タスク委任) のハードコード fallback 温度 */
const DEFAULT_TEMPERATURE_AGENT = 0.2;
/** runAsEvaluator (成果物レビュー) のハードコード fallback 温度 */
const DEFAULT_TEMPERATURE_EVALUATOR = 0.1;

/**
 * runAsAgent の最大ツール呼出回数 (既定 15)。
 * progress.md L142 によれば 15 回到達は珍しくないため、 これより増やすと
 * 「セカンドが試行錯誤に陥り無限委任」 のリスク。 config 経由で上書き可能。
 */
const DEFAULT_MAX_AGENT_ITERATIONS = 15;
/** runAsEvaluator の最大ツール呼出回数 (既定 10)。 評価は探索量が agent より少ない */
const DEFAULT_MAX_EVALUATOR_ITERATIONS = 10;

// セカンドLLM 呼び出しの max_tokens 設計指針:
//   - 中途半端に小さい値を渡すと「上限が近い」とモデルが察知して出力を急ぐ (省略/圧縮) 挙動が
//     出やすい。 余らせるのは構わないので、 常に **モデル上限相当** を狙う。
//   - 具体値は呼び出し側ではなく **プロバイダー側のデフォルト** に委ねる
//     (例: azure-anthropic は Claude 4 系の上限 64000 をデフォルトにしている)。
//   - ユーザーが明示的に `endpoint.contextWindow` を設定していればそれを尊重する
//     (上限超過分はプロバイダーが自動クランプする)。 未設定時は undefined を渡して
//     プロバイダー既定値を発火させる。

export class SecondLLMManager {
  private provider: LLMProvider | null = null;
  private config: SecondLLMConfig | null = null;
  private endpoint: SecondLLMEndpoint | null = null;
  private delegationGuard: DelegationGuard | null = null;
  private sessionId?: string;

  constructor(
    private toolRegistry: ToolRegistry,
    private permissions: PermissionManager,
  ) {}

  /** メインのセッションIDを設定（ログファイル名の共有用） */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** agentId付きのLLMLoggerを生成 */
  private createLogger(agentId: string): LLMLogger {
    return new LLMLogger(agentId, this.sessionId);
  }

  initialize(config: SecondLLMConfig, passphrase?: string) {
    this.config = config;
    if (config.enabled && config.endpoint) {
      this.endpoint = config.endpoint;
      this.provider = createSecondLLMProvider(this.endpoint, passphrase);
    }
    
    // Setup DelegationGuard
    this.delegationGuard = new DelegationGuard({
      maxConsecutiveDelegations: 5,
      maxTotalDelegations: 20,
    });
  }

  isAvailable(): boolean {
    return this.provider !== null && this.config !== null && this.config.enabled;
  }

  onUserTurn(): void {
    if (this.delegationGuard) {
      this.delegationGuard.onUserTurn();
    }
  }

  getConfig(): SecondLLMConfig | null {
    return this.config;
  }

  getEndpoint(): SecondLLMEndpoint | null {
    return this.endpoint;
  }

  getProvider(): LLMProvider | null {
    return this.provider;
  }

  protected checkDelegation(): void {
    if (!this.delegationGuard) return;
    const check = this.delegationGuard.checkDelegation();
    if (!check.allowed) {
      throw new Error(`Second LLM Delegation blocked: ${check.reason}`);
    }
    this.delegationGuard.recordDelegation();
  }

  /**
   * 用途 (consult/agent/evaluator) のサンプリングパラメータを解決する。
   *
   * 優先順位:
   *   1. endpoint.temperature 等 (= /second temperature 等で個別設定された値)
   *   2. config.samplingDefaults.{consultTemperature|agentTemperature|evaluatorTemperature}
   *   3. ハードコード fallback (DEFAULT_TEMPERATURE_*)
   *
   * @param mode 用途。 fallback の選び方とラベル用。
   */
  private resolveSampling(mode: "consult" | "agent" | "evaluator"): {
    temperature: number;
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
  } {
    const ep = this.endpoint;
    const defaults = this.config?.samplingDefaults;
    const configDefault =
      mode === "consult" ? defaults?.consultTemperature
      : mode === "agent" ? defaults?.agentTemperature
      : defaults?.evaluatorTemperature;
    const hardcodedFallback =
      mode === "consult" ? DEFAULT_TEMPERATURE_CONSULT
      : mode === "agent" ? DEFAULT_TEMPERATURE_AGENT
      : DEFAULT_TEMPERATURE_EVALUATOR;
    return {
      temperature: ep?.temperature ?? configDefault ?? hardcodedFallback,
      ...(ep?.top_p !== undefined && { top_p: ep.top_p }),
      ...(ep?.top_k !== undefined && { top_k: ep.top_k }),
      ...(ep?.repetition_penalty !== undefined && { repetition_penalty: ep.repetition_penalty }),
    };
  }

  /**
   * runAsAgent の最大反復回数 (config で上書き可能、 既定 15)。
   */
  private get maxAgentIterations(): number {
    return this.config?.iterationLimits?.maxAgentIterations ?? DEFAULT_MAX_AGENT_ITERATIONS;
  }

  /**
   * runAsEvaluator の最大反復回数 (params で上書き可能、 次に config、 最後に既定 10)。
   */
  private resolveEvaluatorIterations(paramOverride?: number): number {
    return (
      paramOverride
      ?? this.config?.iterationLimits?.maxEvaluatorIterations
      ?? DEFAULT_MAX_EVALUATOR_ITERATIONS
    );
  }

  async consult(prompt: string): Promise<string> {
    if (!this.isAvailable() || !this.provider || !this.endpoint) {
      throw new Error("Second LLM is not configured or enabled.");
    }
    this.checkDelegation();

    const log = this.createLogger("second-llm-consult");
    const spinner = ora(chalk.magenta("Consulting Second LLM...")).start();
    try {
      // Phase 5 第2ラウンド: consult はツール無し単発質問。 戦略プロンプトはコンパクト版で十分。
      const systemPrompt =
        `あなたはメインLLMから単発相談を受けたサブエージェント。 直接的で完結した回答を返す。\n` +
        `- 質問返しはしない (情報不足なら妥当な仮定を置いて回答+「仮定したこと」を併記)\n` +
        `- 与えられた背景・コンテキストの中で答える。 推測の混入は最小限\n` +
        `- ツール実行はできない。 純粋な推論で回答`;
      const messages: Message[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ];

      log.nextTurn();
      log.logRequest(messages, this.endpoint.model);

      const stream = this.provider.chat({
        model: this.endpoint.model,
        messages,
        ...this.resolveSampling("consult"),
        maxTokens: this.endpoint.contextWindow,
        stream: true
      });

      let responseText = "";
      for await (const chunk of stream) {
        if (chunk.type === "text") {
          responseText += chunk.text;
        } else if (chunk.type === "error") {
          throw new Error(chunk.error);
        }
      }

      log.logResponse({ model: this.endpoint.model, text: responseText });
      spinner.succeed(chalk.magenta("Second LLM replied."));
      return responseText.trim();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      getOpsLogger().error("second-llm", "consult failed", {
        model: this.endpoint?.model,
        provider: this.endpoint?.providerType,
        error: err.message,
        stack: err.stack,
      });
      spinner.fail(chalk.red("Second LLM consultation failed."));
      throw e;
    }
  }

  async runAsAgent(prompt: string): Promise<string> {
    if (!this.isAvailable() || !this.provider || !this.endpoint) {
      throw new Error("Second LLM is not configured or enabled.");
    }
    this.checkDelegation();

    const toolDefs = this.toolRegistry.getDefinitions().filter(d => !EXCLUDED_TOOLS.includes(d.function.name));
    const log = this.createLogger("second-llm-agent");

    const spinner = ora(chalk.magenta("Second LLM working as Agent...")).start();
    try {
      // Phase 5 第2ラウンド: メインLLMの system-prompt から戦略原則を継承する。
      // メインとセカンドで「同じ原則を共有する」 ことが目的 (非対称性の解消)。
      const systemPrompt = buildSubAgentStrategyPrompt();
      const messages: Message[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ];

      const toolExecutor = new ToolExecutor(this.toolRegistry, this.permissions);
      // Phase 5 第2ラウンド: セカンドLLM 自身もハーネス介入レイヤを通す。
      // メインから渡される警告 (連続委任警告等) は 既にメイン側で挿入済の prompt に乗ってくるが、
      // セカンド内での失敗 (壁ドンループ・盲目編集) も検出するため independent な state を持つ。
      const harnessState = new HarnessState();
      let iteration = 0;
      const maxIterations = this.maxAgentIterations;

      while (iteration < maxIterations) {
        iteration++;
        log.nextTurn();
        log.logRequest(messages, this.endpoint.model, toolDefs);

        const stream = this.provider.chatWithTools({
          model: this.endpoint.model,
          messages,
          tools: toolDefs,
          ...this.resolveSampling("agent"),
          maxTokens: this.endpoint.contextWindow,
          stream: true
        });

        let responseText = "";
        const toolCalls: ToolCall[] = [];
        let tokensIn: number | undefined;
        let tokensOut: number | undefined;

        for await (const chunk of stream) {
          if (chunk.type === "text") {
            responseText += chunk.text;
          } else if (chunk.type === "tool_call") {
            if (chunk.toolCall) toolCalls.push(chunk.toolCall);
          } else if (chunk.type === "error") {
            throw new Error(chunk.error);
          } else if (chunk.type === "done" && chunk.usage) {
            tokensIn = chunk.usage.promptTokens;
            tokensOut = chunk.usage.completionTokens;
            const cost = globalCostCalculator.calculateForModel(
              this.endpoint.model,
              chunk.usage.promptTokens ?? 0,
              chunk.usage.completionTokens ?? 0,
            );
            globalTokenTracker.record({
              timestamp: new Date().toISOString(),
              provider: this.provider.providerType,
              model: this.endpoint.model,
              inputTokens: chunk.usage.promptTokens ?? 0,
              outputTokens: chunk.usage.completionTokens ?? 0,
              cachedTokens: 0,
              estimatedCostUsd: cost,
            });
          }
        }

        log.logResponse({ model: this.endpoint.model, text: responseText, toolCalls, tokensIn, tokensOut });

        if (responseText) {
          messages.push({ role: "assistant", content: responseText });
          if (toolCalls.length === 0) {
            spinner.succeed(chalk.magenta("Second LLM task completed."));
            return responseText.trim();
          }
        }

        if (toolCalls.length > 0) {
          if (!responseText) {
             messages.push({ role: "assistant", content: "", tool_calls: toolCalls });
          } else {
             messages[messages.length - 1].tool_calls = toolCalls;
          }

          for (const tc of toolCalls) {
            const toolName = tc.function.name;
            spinner.text = chalk.magenta(`Second LLM executing tool: ${toolName}`);

            try {
              const res = await toolExecutor.execute(tc);
              const raw = res.success
                ? (res.output ?? "")
                : `Error: ${res.error ?? ""}\n${res.output ?? ""}`;
              // Phase 5 第2ラウンド: セカンド側でも介入レイヤを通す。
              // 壁ドンループ警告 / Read→Edit 契約 / 連続委任ガード / 旧エラーガイダンスを適用。
              const enriched = enrichToolResult(tc, res.success, raw, harnessState);
              messages.push({ role: "tool", content: enriched, tool_call_id: tc.id });
            } catch (e) {
              messages.push({ role: "tool", content: `Error: ${String(e)}`, tool_call_id: tc.id });
            }
          }
          spinner.text = chalk.magenta("Second LLM working as Agent...");
        } else {
          break;
        }
      }

      spinner.succeed(chalk.magenta("Second LLM task reached max iterations or completed."));
      return "Reached maximum iterations or completed.";
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      getOpsLogger().error("second-llm", "agent run failed", {
        model: this.endpoint?.model,
        provider: this.endpoint?.providerType,
        error: err.message,
        stack: err.stack,
      });
      spinner.fail(chalk.red("Second LLM agent run failed."));
      throw e;
    }
  }

  /**
   * Evaluator用エージェント実行。
   * 読み取り専用ツール（file_read, grep, glob）のみ使用可能。
   * ファイルパス一覧を渡し、Evaluator自身が必要な箇所を読んで評価する。
   */
  async runAsEvaluator(params: {
    systemPrompt: string;
    userPrompt: string;
    maxIterations?: number;
  }): Promise<string> {
    if (!this.isAvailable() || !this.provider || !this.endpoint) {
      throw new Error("Second LLM is not configured or enabled.");
    }
    // Evaluatorは delegationGuard の対象外（独立したレビュープロセス）

    const toolDefs = this.toolRegistry.getDefinitions()
      .filter(d => EVALUATOR_ALLOWED_TOOLS.includes(d.function.name));
    const log = this.createLogger("evaluator");

    const spinner = ora(chalk.cyan("  Evaluator reviewing...")).start();
    try {
      const messages: Message[] = [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ];

      const toolExecutor = new ToolExecutor(this.toolRegistry, this.permissions);
      // Phase 5 第2ラウンド: Evaluator にもハーネス介入を適用 (壁ドンループ検出等)
      const harnessState = new HarnessState();
      let iteration = 0;
      const maxIter = this.resolveEvaluatorIterations(params.maxIterations);

      while (iteration < maxIter) {
        iteration++;
        log.nextTurn();
        log.logRequest(messages, this.endpoint.model, toolDefs);

        const stream = this.provider.chatWithTools({
          model: this.endpoint.model,
          messages,
          tools: toolDefs,
          ...this.resolveSampling("evaluator"),
          maxTokens: this.endpoint.contextWindow,
          stream: true,
        });

        let responseText = "";
        const toolCalls: ToolCall[] = [];
        let tokensIn: number | undefined;
        let tokensOut: number | undefined;

        for await (const chunk of stream) {
          if (chunk.type === "text") {
            responseText += chunk.text;
          } else if (chunk.type === "tool_call") {
            if (chunk.toolCall) toolCalls.push(chunk.toolCall);
          } else if (chunk.type === "error") {
            throw new Error(chunk.error);
          } else if (chunk.type === "done" && chunk.usage) {
            tokensIn = chunk.usage.promptTokens;
            tokensOut = chunk.usage.completionTokens;
            const cost = globalCostCalculator.calculateForModel(
              this.endpoint.model,
              chunk.usage.promptTokens ?? 0,
              chunk.usage.completionTokens ?? 0,
            );
            globalTokenTracker.record({
              timestamp: new Date().toISOString(),
              provider: this.provider.providerType,
              model: this.endpoint.model,
              inputTokens: chunk.usage.promptTokens ?? 0,
              outputTokens: chunk.usage.completionTokens ?? 0,
              cachedTokens: 0,
              estimatedCostUsd: cost,
            });
          }
        }

        log.logResponse({ model: this.endpoint.model, text: responseText, toolCalls, tokensIn, tokensOut });

        if (responseText) {
          messages.push({ role: "assistant", content: responseText });
          if (toolCalls.length === 0) {
            // ツールなしテキスト応答 = 最終回答
            spinner.succeed(chalk.cyan(`  Evaluator completed (${iteration} iterations)`));
            return responseText.trim();
          }
        }

        if (toolCalls.length > 0) {
          if (!responseText) {
            messages.push({ role: "assistant", content: "", tool_calls: toolCalls });
          } else {
            messages[messages.length - 1].tool_calls = toolCalls;
          }

          for (const tc of toolCalls) {
            const toolName = tc.function.name;
            spinner.text = chalk.cyan(`  Evaluator: ${toolName}...`);

            try {
              const res = await toolExecutor.execute(tc);
              const raw = res.success
                ? (res.output ?? "")
                : `Error: ${res.error ?? ""}\n${res.output ?? ""}`;
              // Phase 5 第2ラウンド: Evaluator も介入レイヤを通す
              const enriched = enrichToolResult(tc, res.success, raw, harnessState);
              messages.push({ role: "tool", content: enriched, tool_call_id: tc.id });
            } catch (e) {
              messages.push({ role: "tool", content: `Error: ${String(e)}`, tool_call_id: tc.id });
            }
          }
          spinner.text = chalk.cyan("  Evaluator reviewing...");
        } else {
          break;
        }
      }

      spinner.warn(chalk.cyan(`  Evaluator reached max iterations (${maxIter})`));
      return "Evaluator reached maximum iterations.";
    } catch (e) {
      spinner.fail(chalk.red("  Evaluator failed."));
      throw e;
    }
  }
}
