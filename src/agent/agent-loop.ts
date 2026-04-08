import chalk from "chalk";
import ora from "ora";
import { globalTokenTracker } from "../cost/token-tracker.js";
import { globalCostCalculator } from "../cost/cost-calculator.js";
import { select } from "@inquirer/prompts";
import { nonTTYReader } from "../utils/non-tty-reader.js";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { LLMProvider, ToolCall, ToolDefinition, ContentPart } from "../providers/base-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { PermissionManager, RequestSource } from "../security/permission-manager.js";
import type { HookManager } from "../hooks/hook-manager.js";
import { MessageHistory } from "./message-history.js";
import { ContextManager } from "./context-manager.js";
import { buildSystemPrompt, type SkillInfo } from "./system-prompt.js";
import {
  createSession,
  saveSession,
  type SessionData,
} from "./session-manager.js";
import { PlanManager } from "./plan-mode.js";
import type { ContextModeManager } from "../context/context-mode.js";
import * as logger from "../utils/logger.js";
import { LLMLogger } from "./llm-logger.js";

// marked-terminal でMarkdownをターミナル向けにレンダリング
marked.use(markedTerminal() as Parameters<typeof marked.use>[0]);

function hasMarkdown(text: string): boolean {
  return /^#{1,6}\s|```|\*\*|__|\[.+\]\(.+\)|^\s*[-*+]\s/m.test(text);
}

function renderMarkdown(text: string): string {
  try {
    return marked(text) as string;
  } catch {
    return text;
  }
}

const MAX_TOOL_ITERATIONS = 50;
const MAX_CONNECTION_RETRIES = 3;

/**
 * モデルのアーティファクト/ガベージ出力を検出する。
 * `<12000:` のようなトークンID漏れや [TOOL_CALLS] 形式のネイティブツール呼び出し形式など。
 */
function isGarbageResponse(text: string): boolean {
  const t = text.trim();
  // トークンID漏れパターン: <数字: や <数字>
  if (/^<\d+[:\s>]/.test(t)) return true;
  // Mistral ネイティブツール呼び出し形式（vLLMがOpenAI形式に変換できなかった場合）
  if (t.startsWith("[TOOL_CALLS]")) return true;
  // その他の明らかなアーティファクト（短い特殊文字のみ）
  if (t.length < 5 && /^[<>\[\]@#|{}]+$/.test(t)) return true;
  return false;
}

/** ユーザーメッセージが実装タスクを意図しているか判定する（会話的入力を除外する） */
function isTaskRequest(text: string): boolean {
  const taskPatterns = [
    /実装|作成|書いて|修正|変更|追加|削除|移動|リファクタ|テスト|ビルド|デプロイ/,
    /implement|create|write|fix|modify|change|add|delete|remove|refactor|build|deploy|update/i,
    /ファイル|コード|関数|クラス|モジュール|スクリプト/,
    /file|code|function|class|module|script/i,
    // 継続指示・催促
    /続け|進め|やって|完成|仕上げ|終わらせ|始め|開始/,
    /continue|go ahead|finish|start|proceed/i,
  ];
  return taskPatterns.some((p) => p.test(text));
}

/** モデルの応答がタスク完了を宣言しているか判定する */
function isCompletionResponse(text: string): boolean {
  const completionPatterns = [
    /完了(しました|いたしました|です|致しました)/,
    /完成(しました|いたしました|です|致しました)/,
    /これで.{0,10}(完了|完成|終了)/,
    /以上で.{0,10}(完了|完成|終了)/,
    /すべて.{0,10}(実装済み|完了|完成)/,
    /不足.{0,10}(ありません|見当たりません|ございません)/,
    /追加.{0,10}(不要|ありません|必要ありません)/,
    /task.{0,5}(complete|done|finished)/i,
    /all.{0,10}(implemented|complete|done)/i,
    /nothing.{0,10}(left|remaining|to do)/i,
  ];
  return completionPatterns.some((p) => p.test(text));
}

export class AgentLoop {
  private history: MessageHistory;
  private contextManager: ContextManager;
  private toolExecutor: ToolExecutor;
  private session: SessionData;
  private planManager: PlanManager | null = null;
  private contextModeManager: ContextModeManager | null = null;
  /** Discord Interaction Server などから並行処理を避けるためのフラグ */
  public isProcessing = false;
  /** true: テキストをリアルタイムにストリーミング表示。false: スピナー+完了後Markdownレンダリング */
  private streamingDisplay: boolean = false;
  /** 現在処理中のリクエストの発生元 */
  private currentSource: RequestSource = "cli";
  /** Ctrl+C などによる中断フラグ */
  private _aborted = false;
  /** file_edit 連続失敗カウンタ（ファイルパス → 連続失敗回数） */
  private fileEditFailCounts = new Map<string, number>();
  /** ツールの最大並列実行数 */
  private maxParallelTools: number;
  /** モデルのコンテキストウィンドウサイズ（トークン数） — max_tokens算出に使用 */
  private contextWindow: number;
  /** LLM I/O ロガー */
  private llmLogger: LLMLogger;

  constructor(
    private provider: LLMProvider,
    private model: string,
    private toolRegistry: ToolRegistry,
    private permissions: PermissionManager,
    contextWindow: number,
    compressionThreshold: number,
    contextModeManager?: ContextModeManager,
    hookManager?: HookManager,
    skills?: SkillInfo[],
    agentId: string = "main",
    sessionId?: string,
    streamingDisplay: boolean = false,
    maxParallelTools: number = 3,
    hasSecondLLM: boolean = false,
  ) {
    this.streamingDisplay = streamingDisplay;
    this.maxParallelTools = maxParallelTools;
    this.contextWindow = contextWindow;
    this.contextModeManager = contextModeManager ?? null;
    const systemPrompt = buildSystemPrompt(contextModeManager, skills, hasSecondLLM);
    this.history = new MessageHistory(systemPrompt);
    this.contextManager = new ContextManager(provider, model, contextWindow, compressionThreshold);
    this.toolExecutor = new ToolExecutor(toolRegistry, permissions, hookManager);
    this.session = createSession(model);
    this.llmLogger = new LLMLogger(agentId, sessionId);
    logger.debug(`LLM I/O log: ${this.llmLogger.getFilePath()}`);
  }

  setPlanManager(pm: PlanManager): void {
    this.planManager = pm;
  }

  /** 実行中の処理を中断する（Ctrl+C など）。次のイテレーション冒頭で停止する */
  abort(): void {
    this._aborted = true;
  }

  /** 中断フラグをリセットする（次の run() 開始前に呼ぶ） */
  clearAbort(): void {
    this._aborted = false;
  }

  isAborted(): boolean {
    return this._aborted;
  }

  async run(userMessage: string | ContentPart[], options?: { source?: RequestSource }): Promise<void> {
    this.currentSource = options?.source ?? "cli";
    this.isProcessing = true;
    this._aborted = false;
    try {
    this.history.addUserMessage(userMessage);
    // ユーザーメッセージのテキスト部分を抽出（タスク判定用）
    const userMessageText = typeof userMessage === "string"
      ? userMessage
      : (userMessage as ContentPart[])
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join(" ");
    // <think>タグフィルター（古いOllama向け、ストリーム跨ぎ対応）
    const filterThinkingTags = createThinkingFilter();
    let emptyResponseRetries = 0;
    const MAX_EMPTY_RETRIES = 3;
    let codeBlockRetried = false;
    let consecutiveTextOnly = 0; // ツール未呼び出しテキスト応答の連続回数
    const MAX_TEXT_ONLY_RETRIES = 5;
    let hasExecutedTools = false; // この run() 内でツールを1回でも実行したか
    /** 直前のツール呼び出しシグネチャ（反復検出用） */
    let lastToolSignature = "";
    let repeatToolCount = 0;
    const MAX_REPEAT_TOOL = 3; // 同じツール呼び出しがN回連続で失敗したら中断

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      // 中断チェック
      if (this._aborted) {
        console.log(chalk.yellow("\n  (処理を中断しました)"));
        return;
      }
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

      let receivedTokens = 0; // スピナーモード: 受信トークンカウンター
      let thinkingStarted = false; // ストリーミングモード: [思考]ヘッダー表示済みフラグ
      let finishReason = "stop"; // LLMの終了理由（"length"なら出力が途中で切れた）
      // LLM呼び出しループ: 接続エラー時は自動リトライ、その他はユーザーに判断を委ねる
      let connectionRetries = 0;

      while (!success) {
        try {
          const toolDefs = this.getFilteredToolDefs();
          // LLM I/O ログ: リクエスト記録
          this.llmLogger.nextTurn();
          this.llmLogger.logRequest(
            this.history.getMessages(),
            this.model,
            toolDefs.length > 0 ? toolDefs : undefined,
          );
          const gen = toolDefs.length > 0
            ? this.provider.chatWithTools({
              model: this.model,
              messages: this.history.getMessages(),
              tools: toolDefs,
              maxTokens: this.contextWindow,
              stream: true,
            })
            : this.provider.chat({
              model: this.model,
              messages: this.history.getMessages(),
              maxTokens: this.contextWindow,
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

          for await (const chunk of abortableIterator(gen, () => this._aborted)) {
            if (this._aborted) {
              stopWaitingSpinner();
              if (thinkingSpinner) { thinkingSpinner.stop(); thinkingSpinner = null; }
              if (this.streamingDisplay && hasStartedOutput) process.stdout.write("\n");
              console.log(chalk.yellow("\n  (処理を中断しました)"));
              return;
            }
            switch (chunk.type) {
              case "thinking":
                // Qwen3等のthinkingモデル: reasoning_content を受信
                if (chunk.text) {
                  stopWaitingSpinner();
                  if (this.streamingDisplay) {
                    // ストリーミングモード: グレーでリアルタイム表示
                    if (!thinkingStarted) {
                      thinkingStarted = true;
                      process.stdout.write(chalk.gray("\n[思考]\n"));
                    }
                    process.stdout.write(chalk.gray(chunk.text));
                  } else {
                    // スピナーモード: "考え中..." スピナー
                    if (!thinkingSpinner) {
                      thinkingSpinner = ora(chalk.dim("  考え中...")).start();
                    }
                  }
                  thinkingContent += chunk.text;
                }
                break;
              case "text":
                if (chunk.text) {
                  stopWaitingSpinner();
                  if (this.streamingDisplay) {
                    // ストリーミングモード: リアルタイム表示
                    if (thinkingSpinner) {
                      thinkingSpinner.stop();
                      thinkingSpinner = null;
                    }
                    const displayText = filterThinkingTags(chunk.text);
                    if (displayText) {
                      if (!hasStartedOutput) {
                        hasStartedOutput = true;
                        // thinking直後なら区切り線を挿入
                        if (thinkingStarted) {
                          process.stdout.write(chalk.gray("\n[/思考]\n\n"));
                        } else {
                          process.stdout.write("\n");
                        }
                      }
                      process.stdout.write(displayText);
                    }
                  } else {
                    // スピナーモード: バッファリング + "受信中..." スピナー
                    if (thinkingSpinner) {
                      thinkingSpinner.stop();
                      thinkingSpinner = null;
                    }
                    // <think>...</think> タグをフィルタリング（古いOllamaの場合contentに含まれる）
                    const displayText = filterThinkingTags(chunk.text);
                    if (displayText) {
                      receivedTokens += displayText.split(/\s+/).length;
                      if (!hasStartedOutput) {
                        hasStartedOutput = true;
                        thinkingSpinner = ora({ text: chalk.dim(`  受信中... (${receivedTokens} トークン)`), spinner: "dots" }).start();
                      }
                      if (thinkingSpinner !== null) {
                        thinkingSpinner.text = chalk.dim(`  受信中... (${receivedTokens} トークン)`);
                      }
                    }
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
                finishReason = chunk.finishReason ?? "stop";
                // ストリーミングモード: 表示済みテキストの末尾に改行
                if (this.streamingDisplay && hasStartedOutput) {
                  process.stdout.write("\n");
                }
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
          if (thinkingSpinner) {
            thinkingSpinner.stop();
            thinkingSpinner = null;
          }

          // LLM I/O ログ: レスポンス記録（thinking含む）
          this.llmLogger.logResponse({
            model: this.model,
            thinking: thinkingContent || undefined,
            text: textContent || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          });

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
            receivedTokens = 0;
            thinkingStarted = false;
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
            receivedTokens = 0;
            thinkingStarted = false;
            continue;
          } else {
            // "abort" → この発話を中止してREPLに戻る（プロセスは終了しない）
            // _aborted を立てることで /try などの呼び出し元もループを抜けられる
            this._aborted = true;
            return;
          }
        }
      }

      if (!success) return;

      // finish_reason="length": max_tokensに達して出力が途中で切れた場合、自動的に続きを生成する
      if (finishReason === "length" && textContent.trim().length > 0) {
        console.log(chalk.dim("\n  (出力がmax_tokensに達したため、続きを生成します...)"));
        this.history.addAssistantMessage(textContent, toolCalls.length > 0 ? toolCalls : undefined);
        this.history.addUserMessage("続きを出力してください。途中から再開してください。");
        continue;
      }

      if (hasStartedOutput && !this.streamingDisplay) {
        // スピナーモード: 収集した全テキストをフィルター・レンダリングして表示
        const filteredText = createThinkingFilter()(textContent);
        if (filteredText.trim()) {
          if (hasMarkdown(filteredText)) {
            console.log(renderMarkdown(filteredText));
          } else {
            console.log("\n" + filteredText);
          }
        }
      }

      // Tool calls: execute (parallel when multiple) and continue
      if (toolCalls.length > 0) {
        consecutiveTextOnly = 0; // ツール呼び出し成功でリセット
        hasExecutedTools = true;

        // 同じツール呼び出しの反復検出
        const currentSignature = toolCalls.map(tc => tc.function.name + ":" + tc.function.arguments).join("|");
        if (currentSignature === lastToolSignature) {
          repeatToolCount++;
          if (repeatToolCount >= MAX_REPEAT_TOOL) {
            console.log(chalk.yellow(`\n  同じツール呼び出しが${MAX_REPEAT_TOOL}回連続しています。別のアプローチを試みます...`));
            this.history.addAssistantMessage(textContent, toolCalls);
            // 直前のツール結果を偽造せずに、問題を指摘するメッセージを追加
            for (const tc of toolCalls) {
              this.history.addToolResult(tc.id,
                "Error: このツール呼び出しは同じ引数で繰り返し実行されており、同じ結果が返っています。" +
                "別のアプローチを取ってください。ファイルが存在しない場合は作成し、ツール名を間違えている場合は正しいツールを使ってください。"
              );
            }
            repeatToolCount = 0;
            lastToolSignature = "";
            continue;
          }
        } else {
          repeatToolCount = 1;
          lastToolSignature = currentSignature;
        }

        this.history.addAssistantMessage(textContent, toolCalls);

        let shouldAbort = false;
        if (toolCalls.length === 1) {
          shouldAbort = await this.executeSingleTool(toolCalls[0]);
        } else {
          shouldAbort = await this.executeToolsParallel(toolCalls);
        }

        if (shouldAbort) {
          return;
        }

        continue;
      }

      // ガベージ応答（トークンアーティファクト等）を検出: リプロンプトしても改善しないため中断
      if (toolCalls.length === 0 && textContent.trim().length > 0 && isGarbageResponse(textContent)) {
        console.log(chalk.yellow("\n  モデルの応答が解析できない形式です。プロンプトを変えて再度お試しください。"));
        this.history.addAssistantMessage(textContent);
        return;
      }

      // テキストのみ応答（ツール未呼び出し）の検出とリプロンプト
      // 会話的入力（挨拶など）では発火しない
      // ツール実行後のテキスト応答は結果報告なのでそのまま返す（再プロンプトしない）
      if (
        toolCalls.length === 0 &&
        !codeBlockRetried &&
        !hasExecutedTools &&
        textContent.trim().length > 0 &&
        isTaskRequest(userMessageText) &&
        !isCompletionResponse(textContent)
      ) {
        consecutiveTextOnly++;

        if (consecutiveTextOnly >= MAX_TEXT_ONLY_RETRIES) {
          // 限界到達: ユーザーに報告して中断
          console.log(chalk.yellow("\n  モデルがツール呼び出しを行えません。プロンプトを変えて再度お試しください。"));
          this.history.addAssistantMessage(textContent);
          return;
        }

        if (consecutiveTextOnly >= 3) {
          // 3回以上: 前回の応答を履歴に入れず、強いリプロンプト
          console.log(chalk.dim(`  (テキストのみ応答 ${consecutiveTextOnly}回目 - 前回応答を破棄して再試行)`));
          this.history.addUserMessage(
            "あなたの応答はテキストのみでした。テキストは不要です。" +
            "次のアクションとして必要なツールを呼び出してください。説明せずにツールを実行してください。"
          );
        } else {
          // 1-2回目: 通常のリプロンプト
          this.history.addAssistantMessage(textContent);
          this.history.addUserMessage(
            "ツールを呼び出して実装を開始してください。" +
            "説明は不要です。最初のアクションとしてツールを呼び出してください。"
          );
        }
        continue;
      }

      // コードブロックをテキスト返した場合のリプロンプト（file_write未使用検出）
      if (toolCalls.length === 0 && !codeBlockRetried && hasLargeCodeBlock(textContent)) {
        codeBlockRetried = true;
        console.log(chalk.yellow("\n  コードがテキストで返されました。file_writeツールを使って実際にファイルを作成します..."));
        this.history.addAssistantMessage(textContent);
        this.history.addUserMessage(
          "コードをテキストで返しましたが、実際にファイルを作成してください。" +
          "file_writeツールを呼び出して、指定されたパスにファイルを保存してください。" +
          "コードをチャットに書くのではなく、必ずfile_writeツールを使用してください。"
        );
        continue;
      }

      // リプロンプト後もツールを呼ばず、JSONコードブロックでfile_writeを「説明」している場合
      // → JSONを解析して直接実行する
      if (toolCalls.length === 0 && codeBlockRetried) {
        const fakeWrites = extractFakeFileWriteCalls(textContent);
        if (fakeWrites.length > 0) {
          console.log(chalk.yellow(`\n  ツール呼び出しの代わりにJSONが返されました。${fakeWrites.length}件のfile_writeを直接実行します...`));
          this.history.addAssistantMessage(textContent);
          let shouldAbort = false;
          for (const fw of fakeWrites) {
            const syntheticCall: ToolCall = {
              id: `synthetic_fw_${Date.now()}`,
              type: "function",
              function: { name: "file_write", arguments: JSON.stringify(fw) },
            };
            shouldAbort = await this.executeSingleTool(syntheticCall);
            if (shouldAbort) return;
          }
          // 書き込み完了後、モデルに続きを促す
          this.history.addUserMessage("ファイルの作成が完了しました。");
          continue;
        }
      }

      // Final response
      if (!hasStartedOutput && toolCalls.length === 0) {
        // ユーザーに見える出力がゼロ（thinking onlyや空レスポンス）
        if (emptyResponseRetries < MAX_EMPTY_RETRIES) {
          emptyResponseRetries++;
          console.log(chalk.yellow(`\n  空のレスポンスを受信したため再試行します (${emptyResponseRetries}/${MAX_EMPTY_RETRIES})...`));
          // 同じリクエストをそのまま再送しても同じ結果になるため、ナッジメッセージを追加する
          this.history.addAssistantMessage("（空のレスポンス）");
          this.history.addUserMessage("続けてください。次に必要なアクションを実行してください。");
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
    } finally {
      this.isProcessing = false;
    }
  }

  /** Get tool definitions, filtered by plan mode or Discord source */
  private getFilteredToolDefs(): ToolDefinition[] {
    const allDefs = this.toolRegistry.getDefinitions();

    if (this.planManager?.isInPlanMode()) {
      const allowed = PlanManager.getPlanModeAllowedTools();
      return allDefs.filter((d) => allowed.has(d.function.name));
    }

    if (this.currentSource === "discord" || this.currentSource === "slack") {
      const allowed = this.currentSource === "discord"
        ? this.permissions.getDiscordAllowedToolNames()
        : this.permissions.getSlackAllowedToolNames();
      return allDefs.filter((d) => allowed.has(d.function.name));
    }

    return allDefs;
  }

  /** Execute a single tool call, returning whether to abort the rest of the run loop */
  private async executeSingleTool(toolCall: ToolCall): Promise<boolean> {
    const spinner = ora(chalk.dim(`  ${toolCall.function.name}...`)).start();
    const result = await this.toolExecutor.execute(toolCall, this.currentSource);

    if (result.success) {
      spinner.succeed(chalk.dim(`  ${toolCall.function.name}`));
    } else {
      spinner.fail(chalk.dim(`  ${toolCall.function.name}: ${result.error}`));
    }

    let resultContent = result.success
      ? result.output
      : `Error: ${result.error}\n${result.output}`;

    // エラー時にアクショナブルなガイダンスを付加
    resultContent = enrichToolResult(toolCall.function.name, toolCall.function.arguments, result.success, resultContent);

    // file_edit 連続失敗追跡
    if (toolCall.function.name === "file_edit") {
      let filePath = "";
      try {
        const args = JSON.parse(toolCall.function.arguments ?? "{}");
        filePath = (args.file_path ?? args.path ?? "") as string;
      } catch { /* ignore */ }

      if (!result.success && filePath) {
        const count = (this.fileEditFailCounts.get(filePath) ?? 0) + 1;
        this.fileEditFailCounts.set(filePath, count);
        if (count >= 2) {
          resultContent += "\n\n[システム] このファイルへの file_edit が " + count + " 回連続で失敗しています。" +
            "file_write でファイル全体を書き直してください。";
        }
      } else if (result.success && filePath) {
        // 成功したらカウンタリセット
        this.fileEditFailCounts.delete(filePath);
      }
    }

    this.history.addToolResult(toolCall.id, resultContent);

    return result.abortExecution === true;
  }

  /** Execute multiple tool calls with concurrency limit, returning whether to abort the run loop */
  private async executeToolsParallel(toolCalls: ToolCall[]): Promise<boolean> {
    const limit = this.maxParallelTools;
    console.log(chalk.dim(`\n  ⟹ ${toolCalls.length} tools (max ${limit} parallel)...`));

    // セマフォによる同時実行数制限
    let running = 0;
    const queue: (() => void)[] = [];
    function acquire(): Promise<void> {
      if (running < limit) {
        running++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => queue.push(resolve));
    }
    function release(): void {
      const next = queue.shift();
      if (next) {
        next(); // running は減らさない（次のタスクが即取得）
      } else {
        running--;
      }
    }

    const promises = toolCalls.map(async (toolCall) => {
      await acquire();
      // 中断チェック: 待機中にabortされた場合はスキップ
      if (this._aborted) {
        release();
        return { toolCall, result: { success: false, output: "", error: "中断されました" } };
      }
      try {
        const result = await this.toolExecutor.execute(toolCall, this.currentSource);
        const icon = result.success ? chalk.green("✓") : chalk.red("✗");
        const suffix = result.success ? "" : `: ${result.error}`;
        console.log(chalk.dim(`  ${icon} ${toolCall.function.name}${suffix}`));
        return { toolCall, result };
      } finally {
        release();
      }
    });

    const settled = await Promise.allSettled(promises);
    let shouldAbort = false;

    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        const { toolCall, result } = entry.value;
        let resultContent = result.success
          ? result.output
          : `Error: ${result.error}\n${result.output}`;
        resultContent = enrichToolResult(toolCall.function.name, toolCall.function.arguments, result.success, resultContent);
        this.history.addToolResult(toolCall.id, resultContent);

        if (result.abortExecution) {
          shouldAbort = true;
        }
      } else {
        logger.error("Parallel tool execution error:", entry.reason);
      }
    }

    return shouldAbort;
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

  getContextWindow(): number {
    return this.contextWindow;
  }

  setContextWindow(value: number): void {
    this.contextWindow = value;
    this.contextManager.setContextWindow(value);
  }

  setModel(model: string): void {
    this.model = model;
  }

  getStreamingDisplay(): boolean {
    return this.streamingDisplay;
  }

  setStreamingDisplay(value: boolean): void {
    this.streamingDisplay = value;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getPermissions(): PermissionManager {
    return this.permissions;
  }

  getMaxParallelTools(): number {
    return this.maxParallelTools;
  }

  setMaxParallelTools(value: number): void {
    this.maxParallelTools = Math.max(1, Math.floor(value));
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

  // 非TTYモード（パイプ等）: テキストメニューにフォールバック
  if (!process.stdin.isTTY) {
    process.stdout.write(
      `  1: リトライ (同じリクエストを再送信)\n` +
      `  2: 中止 (プロンプトに戻る)\n` +
      `選択 [1-2]: `
    );
    const answer = await nonTTYReader.readLine();
    return answer === "1" ? "retry" : "abort";
  }

  // TTYモード: inquirer インタラクティブリスト
  try {
    const action = await select<"retry" | "abort">({
      message: "どうしますか？",
      choices: [
        { name: "リトライ (同じリクエストを再送信)", value: "retry" },
        { name: "中止 (プロンプトに戻る)", value: "abort" },
      ],
    });
    return action;
  } catch (e) {
    // stdinが閉じられた場合はabort
    if (e instanceof Error && (e.constructor.name === "ExitPromptError" || e.message.includes("force closed"))) {
      console.log(chalk.yellow("  (入力が閉じられたため中止)"));
      return "abort";
    }
    throw e;
  }
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
  // チャンク境界でタグが分断される場合のバッファ（最大 "<think>" or "</think>" の長さ-1 = 7文字）
  let pendingBuffer = "";

  return (text: string): string => {
    // 前回の残りバッファと今回のテキストを連結
    const input = pendingBuffer + text;
    pendingBuffer = "";

    let result = "";
    let i = 0;

    while (i < input.length) {
      if (!insideThink) {
        // 孤立した </think> を除去（reasoning_content で思考済みのモデルが text 冒頭に残す場合）
        const closeOnlyIdx = input.indexOf("</think>", i);
        const openIdx = input.indexOf("<think>", i);

        // </think> が <think> より先に出現 → 孤立タグなのでスキップ
        if (closeOnlyIdx !== -1 && (openIdx === -1 || closeOnlyIdx < openIdx)) {
          result += input.slice(i, closeOnlyIdx);
          i = closeOnlyIdx + 8; // "</think>".length
          continue;
        }

        if (openIdx === -1) {
          // タグが見つからないが、末尾に "<" で始まる部分一致がある可能性
          // "<think>" (7文字) の部分一致を保留
          const remaining = input.slice(i);
          const holdBack = getPartialTagLength(remaining);
          if (holdBack > 0) {
            result += remaining.slice(0, remaining.length - holdBack);
            pendingBuffer = remaining.slice(remaining.length - holdBack);
          } else {
            result += remaining;
          }
          break;
        }
        result += input.slice(i, openIdx);
        insideThink = true;
        i = openIdx + 7; // "<think>".length
      } else {
        // </think> の終了を検出
        const closeIdx = input.indexOf("</think>", i);
        if (closeIdx === -1) {
          // タグが閉じていない → 残りは全部thinking（バッファに保留）
          // ただし "</think>" の部分一致が末尾にある可能性 → 保留不要（insideThink中は全部捨てる）
          break;
        }
        insideThink = false;
        i = closeIdx + 8; // "</think>".length
      }
    }

    return result;
  };
}

/** テキスト末尾の "<think>" / "</think>" 部分一致の長さを返す（0 = 部分一致なし） */
function getPartialTagLength(text: string): number {
  // "<think>" (7文字) と "</think>" (8文字) の prefix をチェック
  const tags = ["<think>", "</think>"];
  for (let len = Math.min(text.length, 8); len >= 1; len--) {
    const suffix = text.slice(text.length - len);
    for (const tag of tags) {
      if (tag.startsWith(suffix)) {
        return len;
      }
    }
  }
  return 0;
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

/**
 * モデルがfile_writeツールを呼ばずにJSONコードブロックで
 * {"file_path": "...", "content": "..."} を出力した場合にそれを抽出する。
 */
function extractFakeFileWriteCalls(text: string): Array<{ file_path: string; content: string }> {
  const results: Array<{ file_path: string; content: string }> = [];
  const jsonBlockRegex = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let match;
  while ((match = jsonBlockRegex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      if (typeof obj.file_path === "string" && typeof obj.content === "string") {
        results.push({ file_path: obj.file_path, content: obj.content });
      }
    } catch {
      // JSONパース失敗は無視
    }
  }
  return results;
}

/**
 * テキストに「大きなコードブロック」が含まれているか検出する。
 * モデルがfile_writeを使わずコードをテキストで返したケースを検出するために使用する。
 * 5行以上のコードブロックがあればtrueを返す。
 */
function hasLargeCodeBlock(text: string): boolean {
  const codeBlockRegex = /```[\s\S]*?```/g;
  const matches = text.match(codeBlockRegex);
  if (!matches) return false;
  return matches.some((block) => {
    const lines = block.split("\n").length;
    return lines >= 7; // 開閉行 + 5行以上のコード
  });
}

/**
 * AsyncGenerator を abort 可能にするラッパー。
 * 元のイテレーターが次の値を yield するのを待っている間も、
 * 500ms ごとに isAborted() をチェックし、true なら早期終了する。
 * これにより、LLM ストリーミングが長時間ブロックしても Ctrl+C が効く。
 *
 * 注意: AsyncGenerator は同時に1つの .next() しか保留できないため、
 * 同じ Promise を再利用してタイムアウトと競争させる。
 */
async function* abortableIterator<T>(
  gen: AsyncGenerator<T>,
  isAborted: () => boolean,
): AsyncGenerator<T> {
  const POLL_INTERVAL = 500;
  while (true) {
    if (isAborted()) return;
    // gen.next() を1回だけ呼び、その Promise をタイムアウトと繰り返し競争させる
    const nextPromise = gen.next();
    while (true) {
      if (isAborted()) return;
      const result = await Promise.race([
        nextPromise.then((v) => ({ kind: "value" as const, v })),
        new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), POLL_INTERVAL)),
      ]);
      if (result.kind === "timeout") {
        // タイムアウト: abort チェックして再度同じ nextPromise を待つ
        continue;
      }
      // 値が来た
      if (result.v.done) return;
      yield result.v.value;
      break; // 外側ループで次の gen.next() へ
    }
  }
}

/**
 * ツール実行結果にアクショナブルなガイダンスを付加する。
 * ローカルLLMがエラーから次のアクションを自力で判断できない場合の補助。
 * 成功時はそのまま返す。失敗時はエラー内容に応じた具体的な次のステップを追記する。
 */
function enrichToolResult(toolName: string, _args: string, success: boolean, content: string): string {
  if (success) return content;

  const errorLower = content.toLowerCase();

  // file_read: ファイルが見つからない
  if (toolName === "file_read" && errorLower.includes("not found")) {
    return content + "\n\n[ガイド] ファイルが存在しません。次のいずれかを実行してください:" +
      "\n- file_write でこのファイルを新規作成する" +
      "\n- glob で正しいファイルパスを検索する" +
      "\n- 同じパスで file_read を繰り返さない";
  }

  // file_read: ディレクトリを指定した
  if (toolName === "file_read" && errorLower.includes("is a directory")) {
    return content + "\n\n[ガイド] パスはディレクトリです。glob でディレクトリ内のファイル一覧を取得してください。";
  }

  // file_edit: old_string が見つからない
  if (toolName === "file_edit" && errorLower.includes("not found in file")) {
    return content; // 既にfile-edit.ts側にガイダンスあり
  }

  // bash: コマンド実行失敗
  if (toolName === "bash" && errorLower.includes("exit code")) {
    return content + "\n\n[ガイド] コマンドが失敗しました。STDERRのエラーメッセージを読んで原因を特定し、修正してください。";
  }

  // 汎用: 明らかなエラー
  if (errorLower.includes("not found") || errorLower.includes("error")) {
    return content + "\n\n[ガイド] エラーが発生しました。同じ操作を繰り返さず、エラーメッセージに基づいて別のアプローチを取ってください。";
  }

  return content;
}
