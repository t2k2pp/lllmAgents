import ora from "ora";
import chalk from "chalk";
import { globalTokenTracker } from "../cost/token-tracker.js";
import { globalCostCalculator } from "../cost/cost-calculator.js";
import { DelegationGuard } from "./delegation-guard.js";
import { createSecondLLMProvider } from "../providers/provider-factory.js";
import { LLMLogger } from "../agent/llm-logger.js";
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

  async consult(prompt: string): Promise<string> {
    if (!this.isAvailable() || !this.provider || !this.endpoint) {
      throw new Error("Second LLM is not configured or enabled.");
    }
    this.checkDelegation();

    const log = this.createLogger("second-llm-consult");
    const spinner = ora(chalk.magenta("Consulting Second LLM...")).start();
    try {
      const messages: Message[] = [
        { role: "system", content: "You are an expert AI assistant consulted by another AI agent. Provide a direct, factual, and complete answer. Do not ask questions back." },
        { role: "user", content: prompt }
      ];

      log.nextTurn();
      log.logRequest(messages, this.endpoint.model);

      const stream = this.provider.chat({
        model: this.endpoint.model,
        messages,
        temperature: 0.2,
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
      const messages: Message[] = [
        { role: "system", content: "You are an expert AI sub-agent. Complete the task using available tools. Do not ask questions back to the user. Provide the final result of your task." },
        { role: "user", content: prompt }
      ];

      const toolExecutor = new ToolExecutor(this.toolRegistry, this.permissions);
      let iteration = 0;
      const MAX_ITERATIONS = 15;

      while (iteration < MAX_ITERATIONS) {
        iteration++;
        log.nextTurn();
        log.logRequest(messages, this.endpoint.model, toolDefs);

        const stream = this.provider.chatWithTools({
          model: this.endpoint.model,
          messages,
          tools: toolDefs,
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
              messages.push({ role: "tool", content: res.output || res.error || "", tool_call_id: tc.id });
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
      let iteration = 0;
      const maxIter = params.maxIterations ?? 10;

      while (iteration < maxIter) {
        iteration++;
        log.nextTurn();
        log.logRequest(messages, this.endpoint.model, toolDefs);

        const stream = this.provider.chatWithTools({
          model: this.endpoint.model,
          messages,
          tools: toolDefs,
          temperature: 0.1,
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
              messages.push({ role: "tool", content: res.output || res.error || "", tool_call_id: tc.id });
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
