import * as path from "node:path";
import chalk from "chalk";
import ora from "ora";
import { globalTokenTracker } from "../cost/token-tracker.js";
import { globalCostCalculator } from "../cost/cost-calculator.js";
import { select } from "@inquirer/prompts";
import { nonTTYReader } from "../utils/non-tty-reader.js";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { LLMProvider, ToolCall, ToolDefinition, ContentPart } from "../providers/base-provider.js";
import type { ToolRegistry, ToolResult } from "../tools/tool-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { PermissionManager, RequestSource } from "../security/permission-manager.js";
import type { HookManager } from "../hooks/hook-manager.js";
import { MessageHistory } from "./message-history.js";
import { ContextManager } from "./context-manager.js";
import { buildSystemPrompt, type SkillInfo, type LLMProfiles } from "./system-prompt.js";
import {
  createSession,
  saveSession,
  type SessionData,
} from "./session-manager.js";
import { PlanManager } from "./plan-mode.js";
import type { SamplingParams } from "../config/types.js";
import * as logger from "../utils/logger.js";
import { LLMLogger } from "./llm-logger.js";
import { isStructurallyIncomplete } from "../utils/incomplete-response.js";
import { formatToolCall, formatToolError } from "../cli/tool-summary.js";
import { getFirstUseGuide } from "./tool-guides.js";
import { IntentClassifier } from "./intent-classifier.js";
import { Evaluator } from "./evaluator.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
import type { ChatLogger } from "./chat-logger.js";
import { renderEditDiff, renderWriteDiff } from "../cli/diff-display.js";

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
 * 自己点検メッセージの整形。
 *
 * 「偽ユーザー発言」として詰めるのではなく、
 * `[自己点検 N/M]` マーカーで**ハーネス通知であることを明示**してLLMに自問自答を促す。
 * LLMは response_complete を呼ぶか、必要なツールを呼ぶかを選ぶ。
 */
function formatSelfCheck(round: number, max: number, userIntent: string, concern: string): string {
  const intent = userIntent.length > 200 ? userIntent.slice(0, 200) + "..." : userIntent;
  return (
    `[自己点検 ${round}/${max}] 今の応答を確認してください:\n` +
    `  ・ユーザーの依頼「${intent}」に応えていますか？\n` +
    `  ・${concern}\n` +
    `  ・追加作業が不要なら response_complete ツールを呼んでください\n` +
    `  ・作業が残っているなら該当ツールを呼んでください`
  );
}

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


export class AgentLoop {
  private history: MessageHistory;
  private contextManager: ContextManager;
  private toolExecutor: ToolExecutor;
  private session: SessionData;
  private planManager: PlanManager | null = null;
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
  /** Phase 5-D: 壁ドンループ検出 — (toolName + 主要引数) ハッシュごとの連続失敗回数 */
  private wallHitFailCounts = new Map<string, number>();
  /** Phase 5-D: 連続委任ガード — second_llm_agent / task の直近呼び出しID列 (連続回数の検出用) */
  private recentDelegations: { tool: string; ts: number }[] = [];
  /** Phase 5-H: Read→Edit 契約 — 直近 file_read された絶対パス (LRU 風、最大 32 件) */
  private recentReads = new Set<string>();
  /** ツールの最大並列実行数 */
  private maxParallelTools: number;
  /** モデルのコンテキストウィンドウサイズ（トークン数） — max_tokens算出に使用 */
  private contextWindow: number;
  /** サンプリングパラメータ（未指定ならサーバー側デフォルトに委ねる） */
  private samplingParams: SamplingParams;
  /** LLM I/O ロガー */
  private llmLogger: LLMLogger;
  /** 意図分類器（ヒューリスティック + LLM併用） */
  private intentClassifier: IntentClassifier;
  /** 直前ターンのプロンプトトークン数（待機スピナーでの文脈サイズ表示用） */
  private lastPromptTokens = 0;
  /** チャットログ（Obsidian Vault保存、null なら無効） */
  private chatLogger: ChatLogger | null = null;
  /** Evaluator（成果物の独立レビュー） */
  private evaluator: Evaluator;
  /** LLMプロファイル情報（システムプロンプト再構築用。/model description 等の更新時に差し替え可） */
  private llmProfiles?: LLMProfiles;

  constructor(
    private provider: LLMProvider,
    private model: string,
    private toolRegistry: ToolRegistry,
    private permissions: PermissionManager,
    contextWindow: number,
    compressionThreshold: number,
    hookManager?: HookManager,
    skills?: SkillInfo[],
    agentId: string = "main",
    sessionId?: string,
    streamingDisplay: boolean = false,
    maxParallelTools: number = 3,
    hasSecondLLM: boolean = false,
    samplingParams: SamplingParams = {},
    hasObsidian: boolean = false,
    secondLLMManager: SecondLLMManager | null = null,
    llmProfiles?: LLMProfiles,
  ) {
    this.streamingDisplay = streamingDisplay;
    this.maxParallelTools = maxParallelTools;
    this.contextWindow = contextWindow;
    this.samplingParams = samplingParams;
    this.llmProfiles = llmProfiles;
    const systemPrompt = buildSystemPrompt(skills, hasSecondLLM, hasObsidian, llmProfiles);
    this.history = new MessageHistory(systemPrompt);
    this.contextManager = new ContextManager(provider, model, contextWindow, compressionThreshold);
    this.toolExecutor = new ToolExecutor(toolRegistry, permissions, hookManager);
    this.session = createSession(model);
    this.llmLogger = new LLMLogger(agentId, sessionId);
    this.intentClassifier = new IntentClassifier(provider, model);
    this.evaluator = new Evaluator(secondLLMManager, provider, model);
    // セカンドLLMにもセッションIDを共有（ログファイル名の統一用）
    if (secondLLMManager && sessionId) {
      secondLLMManager.setSessionId(sessionId);
    }
    logger.debug(`LLM I/O log: ${this.llmLogger.getFilePath()}`);
  }

  setPlanManager(pm: PlanManager): void {
    this.planManager = pm;
  }

  getChatLogger(): ChatLogger | null {
    return this.chatLogger;
  }

  setChatLogger(cl: ChatLogger | null): void {
    this.chatLogger = cl;
    // MessageHistoryにアシスタント応答のコールバックを設定
    this.history.setAssistantMessageCallback(
      cl
        ? (content, toolCalls) => {
            if (!content || content === "（空のレスポンス）") return;
            const toolSummary = toolCalls && toolCalls.length > 0
              ? toolCalls.map((tc) => tc.function.name).join(", ")
              : undefined;
            cl.logAssistant(content, toolSummary);
          }
        : null,
    );
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
    // チャットログ記録
    if (this.chatLogger) {
      const userText = typeof userMessage === "string"
        ? userMessage
        : (userMessage as ContentPart[])
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join(" ");
      this.chatLogger.logUser(userText);
    }
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
    let hasExecutedTools = false; // この run() 内でツールを1回でも実行したか
    /** 直前のツール呼び出しシグネチャ（反復検出用） */
    let lastToolSignature = "";
    let repeatToolCount = 0;
    /** 検証待ちコードファイルのリスト（file_write/file_edit後、bash未実行ならここに溜まる） */
    let pendingVerification: string[] = [];
    /** Evaluatorレビュー待ちファイルのリスト（コード+ドキュメント両方） */
    let pendingEvalFiles: string[] = [];
    /**
     * 自己点検の累積回数（統合カウンタ）。
     * verification, evaluator, text-only, code-block の4種類の懸念すべてで共有する。
     * 上限到達で追加の自己点検注入は停止しターン終了。
     */
    let selfCheckRounds = 0;
    const MAX_SELF_CHECK_ROUNDS = 3;
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
          // チャットログのパート分割
          this.chatLogger?.onCompressed();
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
              ...this.samplingParams,
            })
            : this.provider.chat({
              model: this.model,
              messages: this.history.getMessages(),
              maxTokens: this.contextWindow,
              stream: true,
              ...this.samplingParams,
            });

          // LLM待機スピナー: リクエスト送信〜最初のチャンク受信まで
          // 文脈情報（msg数 / 直前ターンの送信トークン / contextWindow）も併記してブラックボックス化を防ぐ
          const waitingStartTime = Date.now();
          const msgCount = this.history.getMessages().length;
          const ctxFragments: string[] = [`${msgCount}msg`];
          if (this.lastPromptTokens > 0) {
            const usedK = (this.lastPromptTokens / 1000).toFixed(1);
            const maxK = this.contextWindow >= 1000
              ? `${Math.round(this.contextWindow / 1000)}K`
              : `${this.contextWindow}`;
            ctxFragments.push(`~${usedK}K/${maxK}`);
          }
          const ctxInfo = ctxFragments.join(" · ");
          let receivingStartTime = 0; // 最初のテキストチャンク受信時刻（tok/s 計算用）

          let waitingSpinner: ReturnType<typeof ora> | null = ora({
            text: chalk.dim(`  LLM処理中... (0:00 · ${ctxInfo})`),
            spinner: "dots",
          }).start();

          // 経過時間の定期更新（1秒ごと）
          const waitingTimer = setInterval(() => {
            if (waitingSpinner) {
              const elapsed = Math.floor((Date.now() - waitingStartTime) / 1000);
              waitingSpinner.text = chalk.dim(`  LLM処理中... (${formatElapsed(elapsed)} · ${ctxInfo})`);
            }
          }, 1000);

          const stopWaitingSpinner = (): void => {
            if (waitingTimer) clearInterval(waitingTimer);
            if (waitingSpinner) {
              const elapsed = Math.floor((Date.now() - waitingStartTime) / 1000);
              if (elapsed >= 2) {
                // 2秒以上待った場合のみ経過時間を表示
                waitingSpinner.succeed(chalk.dim(`  LLM応答開始 (${formatElapsed(elapsed)} · ${ctxInfo})`));
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
                        receivingStartTime = Date.now();
                        thinkingSpinner = ora({ text: chalk.dim(`  受信中... (${receivedTokens} tok)`), spinner: "dots" }).start();
                      }
                      if (thinkingSpinner !== null) {
                        const recvElapsed = (Date.now() - receivingStartTime) / 1000;
                        const rate = recvElapsed > 0.3 ? Math.round(receivedTokens / recvElapsed) : 0;
                        const rateText = rate > 0 ? `, ${rate} tok/s` : "";
                        thinkingSpinner.text = chalk.dim(`  受信中... (${receivedTokens} tok${rateText})`);
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
                  // 次回ターンの待機スピナー表示用にプロンプトトークン数を記憶
                  this.lastPromptTokens = chunk.usage.promptTokens ?? this.lastPromptTokens;
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
            finishReason,
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
      // 安全ネット: vLLMがfinish_reason="stop"を誤って返す場合に備え、
      // 構造的に不完全（未閉じコードブロック/テーブル、単語途中終端など）を検出して自動継続する
      const isTruncatedByLength = finishReason === "length" && textContent.trim().length > 0;
      const structural = toolCalls.length === 0 && textContent.trim().length > 0
        ? isStructurallyIncomplete(textContent)
        : { incomplete: false as const };
      if (isTruncatedByLength || structural.incomplete) {
        const structReason = "reason" in structural ? structural.reason : undefined;
        const reason = isTruncatedByLength ? "max_tokens到達" : `構造的不完全: ${structReason}`;
        console.log(chalk.dim(`\n  (${reason}のため、続きを生成します...)`));
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

        // planモード中にコードファイルへの書き込みを検出 → 計画を先に確定するよう促す
        if (this.planManager?.isInPlanMode()) {
          const implTools = PlanManager.getImplementationTools();
          for (const tc of toolCalls) {
            if (implTools.has(tc.function.name)) {
              try {
                const args = JSON.parse(tc.function.arguments ?? "{}");
                const filePath = (args.file_path ?? args.path ?? "") as string;
                if (filePath && isCodeFile(filePath)) {
                  this.history.addUserMessage(
                    "[ハーネス] プランモード中にコードファイルへの書き込みが検出されました。" +
                    "実装を開始する前に、exit_plan_mode で計画をユーザーに提示して承認を得てください。" +
                    "設計書（.md等）の作成はプランモード中でも問題ありません。"
                  );
                  break;
                }
              } catch { /* ignore */ }
            }
          }
        }

        // pendingVerification 追跡: file_write/file_edit → 検証待ちに追加、bash → コード検証クリア
        // pendingEvalFiles 追跡: 全ファイル（コード+ドキュメント）をEvaluatorレビュー用に蓄積
        for (const tc of toolCalls) {
          const toolName = tc.function.name;
          if (toolName === "file_write" || toolName === "file_edit") {
            try {
              const args = JSON.parse(tc.function.arguments ?? "{}");
              const filePath = (args.file_path ?? args.path ?? "") as string;
              if (filePath && isCodeFile(filePath)) {
                if (!pendingVerification.includes(filePath)) {
                  pendingVerification.push(filePath);
                }
              }
              // Evaluator用: コード・ドキュメント両方を蓄積
              if (filePath && (isCodeFile(filePath) || isDocumentFile(filePath))) {
                if (!pendingEvalFiles.includes(filePath)) {
                  pendingEvalFiles.push(filePath);
                }
              }
            } catch { /* ignore parse error */ }
          } else if (toolName === "bash") {
            // bash実行 = コード検証が行われたとみなしてクリア
            pendingVerification = [];
          }
        }

        // response_complete が呼ばれたらターン終了（自己点検ループから明示的に抜ける）
        const rcCall = toolCalls.find(tc => tc.function.name === "response_complete");
        if (rcCall) {
          let summary = "";
          try {
            const args = JSON.parse(rcCall.function.arguments ?? "{}");
            summary = (args.summary as string) ?? "";
          } catch { /* ignore */ }
          if (summary.length > 0) {
            console.log("\n" + chalk.dim(`  [response_complete] ${summary}`));
          }
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

      // 検証未実施チェック: コードファイルを書いた後にbashを呼ばずにテキスト応答した場合
      if (toolCalls.length === 0 && pendingVerification.length > 0 &&
          selfCheckRounds < MAX_SELF_CHECK_ROUNDS &&
          !this.planManager?.isInPlanMode()) {
        selfCheckRounds++;
        const fileList = pendingVerification.map(f => `    - ${f}`).join("\n");
        console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] 検証未実施`));
        this.history.addAssistantMessage(textContent);
        this.history.addUserMessage(
          formatSelfCheck(
            selfCheckRounds, MAX_SELF_CHECK_ROUNDS, userMessageText,
            `以下のファイルの動作確認が未完了です:\n${fileList}\n` +
            `    bash で検証コマンドを実行してください（.ts/.js: node --check, .py: python -m py_compile, プロジェクト全体: build/test/lint）。\n` +
            `    注意: GUIアプリ(pygame等)は構文チェックのみ。直接起動するとタイムアウト。`
          )
        );
        continue;
      }
      // 検証リトライ上限到達: クリアして通常フローへ
      if (toolCalls.length === 0 && pendingVerification.length > 0 &&
          selfCheckRounds >= MAX_SELF_CHECK_ROUNDS) {
        console.log(chalk.yellow(`\n  自己点検を${MAX_SELF_CHECK_ROUNDS}回要求しましたが完了しませんでした。`));
        pendingVerification = [];
      }

      // Evaluatorレビュー: ファイル書き込み後の完了時に自動レビュー（コード+ドキュメント両方）
      if (toolCalls.length === 0 && pendingEvalFiles.length > 0 &&
          selfCheckRounds < MAX_SELF_CHECK_ROUNDS &&
          textContent.trim().length > 0 &&
          !this.planManager?.isInPlanMode()) {
        const result = await this.evaluator.evaluate({
          filePaths: pendingEvalFiles,
          originalRequest: userMessageText,
          assistantResponse: textContent,
        });
        if (!result.passed) {
          selfCheckRounds++;
          const feedback = Evaluator.formatForInjection(result);
          console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] Evaluator不合格`));
          this.history.addAssistantMessage(textContent);
          this.history.addUserMessage(
            formatSelfCheck(
              selfCheckRounds, MAX_SELF_CHECK_ROUNDS, userMessageText,
              `Evaluatorから以下の指摘があります:\n${feedback}`
            )
          );
          continue;
        }
        // 合格 → クリアして通常フローへ
        pendingEvalFiles = [];
      }
      // 自己点検上限到達: Evaluatorもクリアして通常フローへ
      if (pendingEvalFiles.length > 0 && selfCheckRounds >= MAX_SELF_CHECK_ROUNDS) {
        pendingEvalFiles = [];
      }

      // テキストのみ応答（ツール未呼び出し）の検出とリプロンプト
      // 会話的入力（挨拶など）では発火しない
      // ツール実行後のテキスト応答は結果報告なのでそのまま返す（再プロンプトしない）
      const shouldReprompt = toolCalls.length === 0 &&
        !codeBlockRetried &&
        !hasExecutedTools &&
        textContent.trim().length > 0;

      let isTask = false;
      let isCompleted = false;
      if (shouldReprompt) {
        const [intent, completion] = await Promise.all([
          this.intentClassifier.classifyIntent(userMessageText, this.history.getRecentContext(3)),
          this.intentClassifier.classifyCompletion(textContent),
        ]);
        isTask = intent === "task";
        isCompleted = completion === "completed";
      }

      if (shouldReprompt && isTask && !isCompleted) {
        if (selfCheckRounds >= MAX_SELF_CHECK_ROUNDS) {
          // 上限到達: ユーザーに報告して中断
          console.log(chalk.yellow(`\n  自己点検を${MAX_SELF_CHECK_ROUNDS}回実施しましたが response_complete が呼ばれませんでした。`));
          this.history.addAssistantMessage(textContent);
          return;
        }

        selfCheckRounds++;
        console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] ツール未呼び出し`));
        this.history.addAssistantMessage(textContent);
        this.history.addUserMessage(
          formatSelfCheck(
            selfCheckRounds, MAX_SELF_CHECK_ROUNDS, userMessageText,
            `テキスト応答のみでツール呼び出しがありません。依頼の遂行に必要なツール（file_write, bash, 等）を実行してください。`
          )
        );
        continue;
      }

      // コードブロックをテキスト返した場合のリプロンプト（file_write未使用検出）
      if (toolCalls.length === 0 && !codeBlockRetried && hasLargeCodeBlock(textContent) &&
          selfCheckRounds < MAX_SELF_CHECK_ROUNDS) {
        codeBlockRetried = true;
        selfCheckRounds++;
        console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] コードがテキスト応答に含まれています`));
        this.history.addAssistantMessage(textContent);
        this.history.addUserMessage(
          formatSelfCheck(
            selfCheckRounds, MAX_SELF_CHECK_ROUNDS, userMessageText,
            `コードをテキストで返しましたが、実際のファイル作成には file_write ツールが必要です。` +
            `意図したパスにファイルを保存する場合は file_write を呼んでください。`
          )
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
      const isEmptyResponse = toolCalls.length === 0 && textContent.trim().length === 0;
      if (isEmptyResponse || (!hasStartedOutput && toolCalls.length === 0)) {
        // ユーザーに見える出力がゼロ（thinking onlyや空レスポンス、またはストリーム中のみ出力で最終テキスト空）
        if (emptyResponseRetries < MAX_EMPTY_RETRIES) {
          emptyResponseRetries++;
          // 何が起きていたか可視化: 思考のみ / max_tokens到達 / 完全な空レスポンス
          let reason: string;
          if (finishReason === "length") {
            reason = "max_tokens到達で本文なし";
          } else if (thinkingContent.length > 0) {
            reason = `思考${thinkingContent.length}文字のみで本文なし`;
          } else {
            reason = "本文・思考ともに空";
          }
          console.log(chalk.yellow(`\n  空のレスポンス (${reason}) — 再試行します (${emptyResponseRetries}/${MAX_EMPTY_RETRIES})...`));
          // 同じリクエストをそのまま再送しても同じ結果になるため、元の意図を含むナッジメッセージを追加する
          const nudgeIntent = userMessageText.length > 200
            ? userMessageText.slice(0, 200) + "..."
            : userMessageText;
          this.history.addAssistantMessage("（空のレスポンス）");
          this.history.addUserMessage(
            `ユーザーの依頼: 「${nudgeIntent}」\n` +
            "この依頼に対して応答してください。テキストで回答するか、必要ならツールを呼び出してください。"
          );
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
    const summary = formatToolCall(toolCall);
    const spinner = ora(chalk.dim(`  ${summary}...`)).start();
    // 権限確認ダイアログがスピナーに隠れないよう、
    // 確認が必要なツールではスピナーを一時停止してから execute する。
    // execute 内部で permission check → inquirer prompt が走るため、
    // スピナーが stdout を専有していると入力が見えなくなる。
    // ask_user / exit_plan_mode は INHERENTLY_SAFE で permission ask されないが
    // ツール内部で inquirer prompt を出すため同じく停止が必要。
    const toolName = toolCall.function.name;
    const isInteractiveTool = toolName === "ask_user" || toolName === "exit_plan_mode";
    const needsApproval = this.permissions.getPermissionLevel(toolName) === "ask"
      && this.currentSource === "cli";
    if (needsApproval || (isInteractiveTool && this.currentSource === "cli")) {
      spinner.stop();
    }
    const result = await this.toolExecutor.execute(toolCall, this.currentSource);

    if (result.success) {
      spinner.succeed(chalk.dim(`  ${summary}`));
      // ファイル変更時はカラーdiffを表示
      if (result.userDisplay) {
        this.renderUserDisplay(result.userDisplay);
      }
    } else {
      spinner.fail(chalk.dim(`  ${summary}: ${formatToolError(result.error, result.output)}`));
    }

    let resultContent = result.success
      ? result.output
      : `Error: ${result.error}\n${result.output}`;

    // エラー時にアクショナブルなガイダンスを付加
    resultContent = enrichToolResult(toolCall.function.name, toolCall.function.arguments, result.success, resultContent);

    // 段階的開示: ツール初回使用時にガイドテキストを注入
    const guide = getFirstUseGuide(toolCall.function.name);
    if (guide) {
      resultContent += "\n\n" + guide;
    }

    // file_edit 連続失敗追跡 (Phase 2 既存)
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
        this.fileEditFailCounts.delete(filePath);
      }
    }

    // Phase 5-D: 汎化された壁ドンループ検出 (file_read / glob / bash)
    // 同一ツール × 同一主要引数で連続失敗が続いたら強い警告を挿入
    if (!result.success) {
      const key = wallHitKey(toolCall);
      if (key) {
        const cnt = (this.wallHitFailCounts.get(key) ?? 0) + 1;
        this.wallHitFailCounts.set(key, cnt);
        if (cnt >= 2) {
          resultContent +=
            `\n\n[システム][壁ドンループ警告] 同じツール×同じ引数で ${cnt} 回連続失敗。` +
            ` 同じ呼び出しを繰り返さないこと。 別アプローチに切替えるか、 ask_user で状況共有を。` +
            ` (key=${key.slice(0, 80)})`;
        }
      }
    } else {
      // 成功したらこのキーのカウンタを削除
      const key = wallHitKey(toolCall);
      if (key) this.wallHitFailCounts.delete(key);
    }

    // Phase 5-H: Read→Edit 契約 — file_edit が直近に file_read していないパスに走った場合の警告
    if (toolCall.function.name === "file_edit") {
      try {
        const args = JSON.parse(toolCall.function.arguments ?? "{}");
        const filePath = (args.file_path ?? args.path ?? "") as string;
        if (filePath && !this.recentReads.has(path.resolve(filePath))) {
          resultContent +=
            `\n\n[システム][Read→Edit契約] このセッションで file_read していないパスに file_edit を実行しました: ${filePath}` +
            `\n→ 次回からは編集前に file_read で現状を確認してください。 古い情報での編集は old_string 不一致の主因です。`;
        }
      } catch { /* ignore */ }
    }

    // Phase 5-H: file_read 成功時に recentReads に追加 (LRU、 32 件まで)
    if (toolCall.function.name === "file_read" && result.success) {
      try {
        const args = JSON.parse(toolCall.function.arguments ?? "{}");
        const filePath = (args.file_path ?? args.path ?? "") as string;
        if (filePath) {
          const abs = path.resolve(filePath);
          this.recentReads.delete(abs); // re-insert で LRU 風
          this.recentReads.add(abs);
          if (this.recentReads.size > 32) {
            const first = this.recentReads.values().next().value;
            if (first) this.recentReads.delete(first);
          }
        }
      } catch { /* ignore */ }
    }

    // Phase 5-B2: 連続委任ガード — second_llm_agent / task の連続呼び出し検出
    if (toolCall.function.name === "second_llm_agent" || toolCall.function.name === "task") {
      const now = Date.now();
      this.recentDelegations.push({ tool: toolCall.function.name, ts: now });
      // 過去 5 分以内の同一ツール委任のみ保持
      this.recentDelegations = this.recentDelegations.filter((d) => now - d.ts < 5 * 60_000);
      const sameToolRecent = this.recentDelegations.filter((d) => d.tool === toolCall.function.name).length;
      if (sameToolRecent >= 3) {
        resultContent +=
          `\n\n[システム][連続委任警告] ${toolCall.function.name} を直近 ${sameToolRecent} 回連続で呼び出しています。` +
          ` 修正リストを集約して 1 回の委任で完結させる方が効率的です (Delegation Cascade 回避)。` +
          ` 次の委任が必要なら、 まず収まり切らない理由を整理してから。`;
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
        const summary = formatToolCall(toolCall);
        const result = await this.toolExecutor.execute(toolCall, this.currentSource);
        const icon = result.success ? chalk.green("✓") : chalk.red("✗");
        const suffix = result.success ? "" : `: ${formatToolError(result.error, result.output)}`;
        console.log(chalk.dim(`  ${icon} ${summary}${suffix}`));
        if (result.success && result.userDisplay) {
          this.renderUserDisplay(result.userDisplay);
        }
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

        // 段階的開示: ツール初回使用時にガイドテキストを注入
        const guide = getFirstUseGuide(toolCall.function.name);
        if (guide) {
          resultContent += "\n\n" + guide;
        }

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

  /** ツール実行結果のユーザー向けカラーdiff表示 */
  private renderUserDisplay(display: NonNullable<ToolResult["userDisplay"]>): void {
    try {
      if (display.type === "edit-diff" && display.oldString && display.newString) {
        renderEditDiff(display.filePath, display.oldString, display.newString, display.occurrences ?? 1);
      } else if (display.type === "write-diff" && display.newContent) {
        renderWriteDiff(display.filePath, display.oldContent ?? null, display.newContent);
      }
    } catch {
      // diff表示の失敗は無視（メイン処理に影響させない）
    }
  }

  async forceCompress(): Promise<void> {
    await this.contextManager.compress(this.history);
    this.chatLogger?.onCompressed();
  }

  saveCurrentSession(): void {
    this.session.messages = this.history.getRawMessages();
    saveSession(this.session);
    logger.debug(`Session saved: ${this.session.meta.id}`);
  }

  /**
   * LLMプロファイル（description等）を差し替えてシステムプロンプトを再構築する。
   * REPL で /model description / /second description を実行した直後に呼ぶと、
   * 次ターン以降のLLM呼び出しで新しい特性説明が反映される。
   */
  updateLLMProfiles(profiles: LLMProfiles, skills?: SkillInfo[], hasSecondLLM?: boolean, hasObsidian?: boolean): void {
    this.llmProfiles = profiles;
    const systemPrompt = buildSystemPrompt(skills, hasSecondLLM, hasObsidian, profiles);
    this.history.updateSystemPrompt(systemPrompt);
  }

  restoreSession(sessionData: SessionData): void {
    this.session = sessionData;
    const systemPrompt = buildSystemPrompt(undefined, undefined, undefined, this.llmProfiles);
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
    // 内部コンポーネントにも伝播（contextManager 内のcompressor、intent-classifier、evaluator）
    this.contextManager.setProvider(this.provider, model);
    this.intentClassifier.setProvider(this.provider, model);
    this.evaluator.setMainProvider(this.provider, model);
  }

  /**
   * メインLLMのProviderを差し替える。/model url, /model provider 経由で
   * 接続先を実行時に変更する際に呼ぶ。modelも同時に渡せば一括反映される。
   */
  setProvider(provider: LLMProvider, model?: string): void {
    this.provider = provider;
    if (model) this.model = model;
    this.contextManager.setProvider(provider, this.model);
    this.intentClassifier.setProvider(provider, this.model);
    this.evaluator.setMainProvider(provider, this.model);
  }

  getSamplingParams(): SamplingParams {
    return { ...this.samplingParams };
  }

  /**
   * 単一サンプリングパラメータを更新する。
   * value === undefined で「未指定（サーバーデフォルトに委ねる）」へ戻す。
   * 次のLLM呼び出しから即時反映される。
   */
  setSamplingParam(name: keyof SamplingParams, value: number | undefined): void {
    if (value === undefined) {
      delete this.samplingParams[name];
    } else {
      this.samplingParams[name] = value;
    }
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

/** コードファイル（bash検証が意味を持つファイル）かどうかを判定する */
function isCodeFile(filePath: string): boolean {
  const codeExtensions = new Set([
    ".ts", ".js", ".tsx", ".jsx", ".mts", ".mjs", ".cjs",
    ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
    ".css", ".scss", ".html", ".vue", ".svelte",
    ".json", ".yaml", ".yml", ".toml", ".sql", ".sh", ".bash",
  ]);
  const ext = filePath.lastIndexOf(".") >= 0
    ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
    : "";
  return codeExtensions.has(ext);
}

/** ドキュメントファイ���（Evaluatorレビュー対象）かどうかを判定する */
function isDocumentFile(filePath: string): boolean {
  const docExtensions = new Set([".md", ".txt", ".rst", ".adoc", ".org"]);
  const ext = filePath.lastIndexOf(".") >= 0
    ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
    : "";
  return docExtensions.has(ext);
}

/**
 * Phase 5-D: 壁ドンループ検出キー生成。
 * (toolName, 主要引数) を結合した識別子を返す。 識別子が等しいツール呼び出しが
 * 連続失敗した場合、 「同じ呼び出しを繰り返している」 と判断できる。
 * 主要引数の選び方:
 *   - file_read / file_edit / file_write: file_path
 *   - glob: pattern + path
 *   - grep: pattern + path
 *   - bash: command (先頭 80 文字)
 *   - 上記以外は null (検出対象外)
 */
function wallHitKey(toolCall: ToolCall): string | null {
  const name = toolCall.function.name;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments ?? "{}");
  } catch {
    return null;
  }
  switch (name) {
    case "file_read":
    case "file_write":
      return `${name}:${args.file_path ?? ""}`;
    case "glob":
      return `glob:${args.pattern ?? ""}|${args.path ?? ""}`;
    case "grep":
      return `grep:${args.pattern ?? ""}|${args.path ?? ""}`;
    case "bash": {
      const cmd = String(args.command ?? "").slice(0, 80);
      return `bash:${cmd}`;
    }
    default:
      return null;
  }
}

