import chalk from "chalk";
import ora from "ora";
import { globalTokenTracker } from "../cost/token-tracker.js";
import { globalCostCalculator } from "../cost/cost-calculator.js";
import inquirer from "inquirer";
import type { LLMProvider, ToolCall, ToolDefinition } from "../providers/base-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { PermissionManager } from "../security/permission-manager.js";
import type { HookManager } from "../hooks/hook-manager.js";
import { MessageHistory } from "./message-history.js";
import { ContextManager } from "./context-manager.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  createSession,
  saveSession,
  type SessionData,
} from "./session-manager.js";
import { PlanManager } from "./plan-mode.js";
import type { ContextModeManager } from "../context/context-mode.js";
import * as logger from "../utils/logger.js";

const MAX_TOOL_ITERATIONS = 50;
const MAX_CONNECTION_RETRIES = 3;

export class AgentLoop {
  private history: MessageHistory;
  private contextManager: ContextManager;
  private toolExecutor: ToolExecutor;
  private session: SessionData;
  private planManager: PlanManager | null = null;
  private contextModeManager: ContextModeManager | null = null;

  constructor(
    private provider: LLMProvider,
    private model: string,
    private toolRegistry: ToolRegistry,
    private permissions: PermissionManager,
    contextWindow: number,
    compressionThreshold: number,
    contextModeManager?: ContextModeManager,
    hookManager?: HookManager,
  ) {
    this.contextModeManager = contextModeManager ?? null;
    const systemPrompt = buildSystemPrompt(contextModeManager);
    this.history = new MessageHistory(systemPrompt);
    this.contextManager = new ContextManager(provider, model, contextWindow, compressionThreshold);
    this.toolExecutor = new ToolExecutor(toolRegistry, permissions, hookManager);
    this.session = createSession(model);
  }

  setPlanManager(pm: PlanManager): void {
    this.planManager = pm;
  }

  async run(userMessage: string): Promise<void> {
    this.history.addUserMessage(userMessage);
    // <think>タグフィルター（古いOllama向け、ストリーム跨ぎ対応）
    const filterThinkingTags = createThinkingFilter();
    let emptyResponseRetries = 0;
    const MAX_EMPTY_RETRIES = 3;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      // Context compression check
      if (this.contextManager.shouldCompress(this.history)) {
        const compressSpinner = ora("コンテキストを圧縮中...").start();
        try {
          await this.contextManager.compress(this.history);
          compressSpinner.succeed("コンテキストを圧縮しました");
        } catch (e) {
          compressSpinner.fail("圧縮に失敗しました");
          logger.error("Context compression failed:", e);
        }
      }

      // Call LLM with retry
      let textContent = "";
      let thinkingContent = "";
      const toolCalls: ToolCall[] = [];
      let hasStartedOutput = false;
      let thinkingSpinner: ReturnType<typeof ora> | null = null;
      let success = false;

      // LLM呼び出しループ: 接続エラー時は自動リトライ、その他はユーザーに判断を委ねる
      let connectionRetries = 0;

      while (!success) {
        try {
          const toolDefs = this.getFilteredToolDefs();
          const gen = toolDefs.length > 0
            ? this.provider.chatWithTools({
              model: this.model,
              messages: this.history.getMessages(),
              tools: toolDefs,
              stream: true,
            })
            : this.provider.chat({
              model: this.model,
              messages: this.history.getMessages(),
              stream: true,
            });

          // LLM待機スピナー: リクエスト送信〜最初のチャンク受信まで
          const waitingStartTime = Date.now();
          let waitingSpinner: ReturnType<typeof ora> | null = ora({
            text: chalk.dim("  LLM処理中..."),
            spinner: "dots",
          }).start();

          // 経過時間の定期更新（1秒ごと）
          const waitingTimer = setInterval(() => {
            if (waitingSpinner) {
              const elapsed = Math.floor((Date.now() - waitingStartTime) / 1000);
              waitingSpinner.text = chalk.dim(`  LLM処理中... (${formatElapsed(elapsed)})`);
            }
          }, 1000);

          const stopWaitingSpinner = (): void => {
            if (waitingTimer) clearInterval(waitingTimer);
            if (waitingSpinner) {
              const elapsed = Math.floor((Date.now() - waitingStartTime) / 1000);
              if (elapsed >= 2) {
                // 2秒以上待った場合のみ経過時間を表示
                waitingSpinner.succeed(chalk.dim(`  LLM応答開始 (${formatElapsed(elapsed)})`));
              } else {
                waitingSpinner.stop();
              }
              waitingSpinner = null;
            }
          };

          for await (const chunk of gen) {
            switch (chunk.type) {
              case "thinking":
                // Qwen3等のthinkingモデル: reasoning_content を受信
                if (chunk.text) {
                  // 待機スピナーが動いていたら停止
                  stopWaitingSpinner();
                  if (!thinkingSpinner) {
                    thinkingSpinner = ora(chalk.dim("  考え中...")).start();
                  }
                  thinkingContent += chunk.text;
                }
                break;
              case "text":
                if (chunk.text) {
                  // 待機スピナーが動いていたら停止
                  stopWaitingSpinner();
                  // thinkingスピナーが動いていたら停止
                  if (thinkingSpinner) {
                    thinkingSpinner.stop();
                    thinkingSpinner = null;
                  }
                  // <think>...</think> タグをフィルタリング（古いOllamaの場合contentに含まれる）
                  const displayText = filterThinkingTags(chunk.text);
                  if (displayText) {
                    if (!hasStartedOutput) {
                      hasStartedOutput = true;
                      process.stdout.write("\n");
                    }
                    process.stdout.write(displayText);
                  }
                  textContent += chunk.text;
                }
                break;
              case "tool_call":
                // 待機スピナーが動いていたら停止
                stopWaitingSpinner();
                // thinkingスピナーが動いていたら停止
                if (thinkingSpinner) {
                  thinkingSpinner.stop();
                  thinkingSpinner = null;
                }
                if (chunk.toolCall) {
                  toolCalls.push(chunk.toolCall);
                }
                break;
              case "error":
                stopWaitingSpinner();
                if (thinkingSpinner) {
                  thinkingSpinner.fail("エラー");
                  thinkingSpinner = null;
                }
                throw new Error(chunk.error ?? "LLM error");
              case "done":
                if (chunk.usage) {
                  const cost = globalCostCalculator.calculateForModel(
                    this.model,
                    chunk.usage.promptTokens ?? 0,
                    chunk.usage.completionTokens ?? 0
                  );
                  globalTokenTracker.record({
                    timestamp: new Date().toISOString(),
                    provider: this.provider.providerType,
                    model: this.model,
                    inputTokens: chunk.usage.promptTokens ?? 0,
                    outputTokens: chunk.usage.completionTokens ?? 0,
                    cachedTokens: 0,
                    estimatedCostUsd: cost,
                    sessionId: this.session.meta.id
                  });
                }
                stopWaitingSpinner();
                if (thinkingSpinner) {
                  thinkingSpinner.stop();
                  thinkingSpinner = null;
                }
                break;
            }
          }

          // ストリーム完了後もスピナーが残っていたらクリーンアップ
          stopWaitingSpinner();

          success = true;
          connectionRetries = 0;
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));

          // 接続エラー（ECONNREFUSED等）の場合: 自動リトライ（上限あり）
          if (isConnectionError(err) && connectionRetries < MAX_CONNECTION_RETRIES) {
            connectionRetries++;
            const waitMs = 2000 * connectionRetries; // 2s, 4s, 6s
            console.log(chalk.yellow(`\n  接続エラー: ${err.message}`));
            console.log(chalk.yellow(`  サーバー復帰を待機中... (${connectionRetries}/${MAX_CONNECTION_RETRIES})`));
            await sleep(waitMs);
            textContent = "";
            thinkingContent = "";
            toolCalls.length = 0;
            hasStartedOutput = false;
            thinkingSpinner = null;
            continue;
          }

          // その他のエラー or 接続リトライ上限: ユーザーに判断を委ねる
          console.error(chalk.red(`\n  エラー: ${err.message}`));
          const action = await askUserOnError(err);

          if (action === "retry") {
            // ユーザーが明示的にリトライを選択
            connectionRetries = 0;
            textContent = "";
            thinkingContent = "";
            toolCalls.length = 0;
            hasStartedOutput = false;
            thinkingSpinner = null;
            continue;
          } else {
            // "abort" → この発話を中止してREPLに戻る（プロセスは終了しない）
            return;
          }
        }
      }

      if (!success) return;

      if (hasStartedOutput) {
        process.stdout.write("\n");
      }

      // Tool calls: execute (parallel when multiple) and continue
      if (toolCalls.length > 0) {
        this.history.addAssistantMessage(textContent, toolCalls);

        if (toolCalls.length === 1) {
          await this.executeSingleTool(toolCalls[0]);
        } else {
          await this.executeToolsParallel(toolCalls);
        }
        continue;
      }

      // Final response
      if (!hasStartedOutput && toolCalls.length === 0) {
        // ユーザーに見える出力がゼロ（thinking onlyや空レスポンス）
        if (emptyResponseRetries < MAX_EMPTY_RETRIES) {
          emptyResponseRetries++;
          console.log(chalk.yellow(`\n  空のレスポンスを受信したため再試行します (${emptyResponseRetries}/${MAX_EMPTY_RETRIES})...`));
          continue;
        }

        const hasThinking = thinkingContent.length > 0 || textContent.includes("<think>");
        const hint = hasThinking
          ? "（モデルは考えましたが、応答が生成されませんでした。プロンプトを変えて再度お試しください）"
          : "（モデルから空のレスポンスが返されました。再度お試しください）";
        console.log(chalk.yellow(`\n  ${hint}`));
        // 空メッセージは履歴に入れない
        return;
      }
      this.history.addAssistantMessage(textContent);
      return;
    }

    console.log(chalk.yellow("\n  Maximum tool iterations reached."));
  }

  /** Get tool definitions, filtered by plan mode if active */
  private getFilteredToolDefs(): ToolDefinition[] {
    const allDefs = this.toolRegistry.getDefinitions();

    if (this.planManager?.isInPlanMode()) {
      const allowed = PlanManager.getPlanModeAllowedTools();
      return allDefs.filter((d) => allowed.has(d.function.name));
    }

    return allDefs;
  }

  /** Execute a single tool call */
  private async executeSingleTool(toolCall: ToolCall): Promise<void> {
    const spinner = ora(chalk.dim(`  ${toolCall.function.name}...`)).start();
    const result = await this.toolExecutor.execute(toolCall);

    if (result.success) {
      spinner.succeed(chalk.dim(`  ${toolCall.function.name}`));
    } else {
      spinner.fail(chalk.dim(`  ${toolCall.function.name}: ${result.error}`));
    }

    const resultContent = result.success
      ? result.output
      : `Error: ${result.error}\n${result.output}`;
    this.history.addToolResult(toolCall.id, resultContent);
  }

  /** Execute multiple tool calls in parallel with Promise.allSettled */
  private async executeToolsParallel(toolCalls: ToolCall[]): Promise<void> {
    console.log(chalk.dim(`\n  ⟹ ${toolCalls.length} tools in parallel...`));

    const promises = toolCalls.map(async (toolCall) => {
      const result = await this.toolExecutor.execute(toolCall);
      const icon = result.success ? chalk.green("✓") : chalk.red("✗");
      const suffix = result.success ? "" : `: ${result.error}`;
      console.log(chalk.dim(`  ${icon} ${toolCall.function.name}${suffix}`));
      return { toolCall, result };
    });

    const settled = await Promise.allSettled(promises);

    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        const { toolCall, result } = entry.value;
        const resultContent = result.success
          ? result.output
          : `Error: ${result.error}\n${result.output}`;
        this.history.addToolResult(toolCall.id, resultContent);
      } else {
        logger.error("Parallel tool execution error:", entry.reason);
      }
    }
  }

  async forceCompress(): Promise<void> {
    await this.contextManager.compress(this.history);
  }

  saveCurrentSession(): void {
    this.session.messages = this.history.getRawMessages();
    saveSession(this.session);
    logger.debug(`Session saved: ${this.session.meta.id}`);
  }

  restoreSession(sessionData: SessionData): void {
    this.session = sessionData;
    const systemPrompt = buildSystemPrompt(this.contextModeManager ?? undefined);
    this.history = new MessageHistory(systemPrompt);
    for (const msg of sessionData.messages) {
      if (msg.role === "user") {
        this.history.addUserMessage(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      } else if (msg.role === "assistant") {
        this.history.addAssistantMessage(
          typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          msg.tool_calls,
        );
      } else if (msg.role === "tool") {
        this.history.addToolResult(msg.tool_call_id ?? "", typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      }
    }
  }

  getHistory(): MessageHistory {
    return this.history;
  }

  getProvider(): LLMProvider {
    return this.provider;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getPermissions(): PermissionManager {
    return this.permissions;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * エラー発生時にユーザーに判断を委ねる。
 * プロセスは終了しない。ユーザーが /quit するまで REPL は動き続ける。
 */
async function askUserOnError(err: Error): Promise<"retry" | "abort"> {
  const hint = isConnectionError(err)
    ? "サーバーに接続できません。サーバーの状態を確認してください。"
    : "LLMからの応答でエラーが発生しました。";

  console.log(chalk.dim(`  ${hint}`));

  const { action } = await inquirer.prompt<{ action: "retry" | "abort" }>([
    {
      type: "list",
      name: "action",
      message: "どうしますか？",
      choices: [
        { name: "リトライ (同じリクエストを再送信)", value: "retry" },
        { name: "中止 (プロンプトに戻る)", value: "abort" },
      ],
    },
  ]);

  return action;
}

/**
 * 接続エラーかどうかを判定する。
 *
 * リトライすべきエラー（サーバーが一時的に不到達）:
 * - ECONNREFUSED: サーバーが起動していない/再起動中
 * - ECONNRESET: 接続がリセットされた
 * - ENOTFOUND: DNS解決できない
 * - fetch failed: ネットワーク到達不能
 *
 * リトライすべきでないエラー（待っても変わらない/輻輳悪化）:
 * - タイムアウト（AbortError）: LLMが処理中なのに打ち切ってリトライしても輻輳するだけ
 * - HTTP 4xx/5xx: サーバーは到達できているがリクエストに問題あり
 * - LLMレスポンスエラー: パースエラー等
 */

/**
 * ストリーミング中の <think>...</think> タグをフィルタリングする。
 *
 * 古いOllama（<0.6）ではthinking contentがdelta.contentに
 * <think>...</think>タグとして含まれる。
 * ストリーミングではタグが複数チャンクに跨がるため、
 * 状態を持つクロージャで処理する。
 */
function createThinkingFilter(): (text: string) => string {
  let insideThink = false;

  return (text: string): string => {
    let result = "";
    let i = 0;

    while (i < text.length) {
      if (!insideThink) {
        // <think> の開始を検出
        const openIdx = text.indexOf("<think>", i);
        if (openIdx === -1) {
          result += text.slice(i);
          break;
        }
        result += text.slice(i, openIdx);
        insideThink = true;
        i = openIdx + 7; // "<think>".length
      } else {
        // </think> の終了を検出
        const closeIdx = text.indexOf("</think>", i);
        if (closeIdx === -1) {
          // タグが閉じていない → 残りは全部thinking
          break;
        }
        insideThink = false;
        i = closeIdx + 8; // "</think>".length
      }
    }

    return result;
  };
}

function isConnectionError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("socket hang up")
  );
}

/** 経過秒数を "0:05" や "1:23" 形式にフォーマットする */
function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
