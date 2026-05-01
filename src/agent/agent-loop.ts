import chalk from "chalk";
import ora from "ora";
import { HarnessState, enrichToolResult } from "./harness-intervention.js";
import { formatSelfCheck, rephraseUserIntent } from "./self-check-messages.js";
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
import { getOpsLogger } from "../utils/ops-logger.js";
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

// formatSelfCheck は src/agent/self-check-messages.ts に移動 (ID-012: 2026-04-30 共通化)。
// メインと SubAgent の両方が同じフォーマッタを使うため。

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
  /** Phase 5 第2ラウンド: ハーネス介入の状態 (file_edit/壁ドン/Read→Edit/連続委任) を一元管理 */
  private harnessState = new HarnessState();
  /**
   * Phase 5 第10ラウンド: 「対話必須」 ロック。 統合された 1 つの状態で扱う。
   *
   * 哲学: 拒否や委任失敗は「壁」 ではなく「対話のきっかけ」。 LLM が独断で再試行/
   * 自分で代替する前に、 ask_user でユーザーに「理由」 を確認する流れを構造的に強制する。
   * (Round 9 で deniedWritePaths による永続自動拒否を実装したが、 ユーザー指摘により
   * 「ユーザーも操作ミスし得る、 心変わりもある」 ため hard barrier は不適切と判断。
   * Round 10 で「対話を促す lock」 へ置換)
   *
   * 発動契機: (1) ユーザーが file_edit/file_write を拒否 (2) second_llm_* が失敗 +
   * ユーザーが委任を明示。 解除契機: ask_user 呼出 / response_complete / 5 分タイムアウト。
   * lock 中は file_write / file_edit を tool 層で拒否する。 file_read / grep / glob /
   * bash / second_llm_* は通す (情報収集 / 検証 / retry 準備は許容)。
   */
  private dialogueLockUntil = 0;
  /** lock 発動の理由 (エラー文言用、 複数の理由が積もる可能性) */
  private dialogueLockReasons: string[] = [];
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
      let tokensIn: number | undefined;
      let tokensOut: number | undefined;
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
                  tokensIn = chunk.usage.promptTokens;
                  tokensOut = chunk.usage.completionTokens;
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
            tokensIn,
            tokensOut,
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
            getOpsLogger().warn("retry", "connection retry scheduled", {
              attempt: connectionRetries,
              max: MAX_CONNECTION_RETRIES,
              waitMs,
              error: err.message,
              model: this.model,
            });
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
          getOpsLogger().error("llm", "LLM call failed (asking user)", {
            error: err.message,
            stack: err.stack,
            model: this.model,
            connectionRetries,
          });
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
          // 同じリクエストをそのまま再送しても同じ結果になるため、元の意図を含むナッジメッセージを追加する。
          // 2026-05-01: 「promise だけ返す」 ループ対策として B 案を実装:
          //   ・「応答を返さないで」 等の沈黙系依頼は rephraseUserIntent で翻訳して提示
          //   ・「了解しました / 実装します 等の promise テキストだけでは作業継続と認識しない」 を明示
          const rephrasedIntent = rephraseUserIntent(userMessageText);
          const nudgeIntent = rephrasedIntent.length > 200
            ? rephrasedIntent.slice(0, 200) + "..."
            : rephrasedIntent;
          this.history.addAssistantMessage("（空のレスポンス）");
          this.history.addUserMessage(
            `[ハーネス通知] 直前の応答が空またはテキストのみで、 ツール呼出がありませんでした。\n` +
            `「了解しました」「実装します」「続きを行います」 等の promise テキストだけではハーネスは作業継続と認識しません。\n` +
            `ユーザーの意図: ${nudgeIntent}\n` +
            `次の手として、 todo の未完了項目があれば該当ツール (file_write / file_edit / bash 等) を直接呼んで作業を進めてください。 中間報告のテキストは不要です。`
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

  /**
   * Phase 5 第9ラウンド (Gate 2): ユーザー直近メッセージに委任意図キーワードがあるか?
   * (「セカンドLLM」「セカンド LLM」「second llm」「サブエージェント」「委任」「頼んで」「依頼」 等)
   */
  private hasRecentDelegationIntent(): boolean {
    const messages = this.history.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user") {
        const content = typeof m.content === "string" ? m.content : "";
        return /セカンド\s*(?:llm|エージェント|モデル)?|second\s*llm|サブ\s*エージェント|sub.?agent|委任|頼んで|依頼/i.test(content);
      }
    }
    return false;
  }

  /**
   * Phase 5 第10ラウンド: tool 実行結果を受けて「対話必須ロック」 を発動する。
   *
   * 発動契機:
   *   1. ユーザーが file_edit / file_write を拒否 (= permission deny)
   *   2. second_llm_* が失敗 + ユーザーが委任意図キーワードを直近メッセージに含めていた
   *
   * 既にロック中なら理由を追加するだけ (タイムアウト延長はしない)。
   */
  private maybeTriggerDialogueLock(
    toolName: string,
    result: import("../tools/tool-registry.js").ToolResult,
  ): void {
    const reasons: string[] = [];

    // 契機1: ユーザー拒否 (file_edit/file_write)
    if (
      !result.success &&
      (toolName === "file_edit" || toolName === "file_write") &&
      typeof result.error === "string" &&
      result.error.includes("ユーザーがこの操作を拒否しました")
    ) {
      reasons.push(
        `直前にユーザーが ${toolName} を拒否しました。 ` +
          `「壁」 ではなく「対話のきっかけ」 として受け止め、 なぜ拒否されたか (パス違い/内容違い/操作ミス/心変わり等) をユーザーに確認すること`,
      );
    }

    // 契機2: 委任失敗 + ユーザーが委任を明示
    if (
      !result.success &&
      (toolName === "second_llm_agent" || toolName === "second_llm_consult") &&
      this.hasRecentDelegationIntent()
    ) {
      const errStr = String(result.error ?? "");
      const m = errStr.match(/\[セカンドLLM失敗:([A-Z_]+)\]/);
      const cat = m?.[1] ?? "UNKNOWN";
      reasons.push(
        `セカンドLLM 呼出が失敗しました (${cat})。 ユーザーが委任を明示しているので、 ` +
          `メイン側で代替実行する前に ask_user で 3 択 (リトライ / メイン側で実行 / モデル切替) を確認すること`,
      );
    }

    if (reasons.length === 0) return;

    // 既にロック中なら理由追加のみ。 新規ならタイマー設定。
    if (this.dialogueLockUntil <= Date.now()) {
      this.dialogueLockUntil = Date.now() + 5 * 60_000; // 5 min
    }
    this.dialogueLockReasons.push(...reasons);
    console.log(chalk.yellow(`  🔒 対話必須ロック発動 (file_write/file_edit を拒否、 ask_user で解除)`));
  }

  /**
   * Phase 5 第10ラウンド: tool 実行直前の「対話必須ロック」 チェック。
   *
   * lock 中で禁止対象 (file_write/file_edit) なら、 toolExecutor に渡さず synthetic
   * エラー結果を返す。 ask_user / response_complete でロック解除。
   * 戻り値: lock 発動なら error 結果、 通常通り進めるなら null。
   */
  private checkDialogueLock(toolName: string): { error: string } | null {
    // ask_user / response_complete はロック解除の合図 (= ユーザーとの対話/完了)
    if (toolName === "ask_user" || toolName === "response_complete") {
      if (this.dialogueLockUntil > Date.now()) {
        this.dialogueLockUntil = 0;
        this.dialogueLockReasons = [];
      }
      return null;
    }
    // ロック未発動 / 期限切れ
    if (this.dialogueLockUntil <= Date.now()) return null;
    // ロック中の禁止対象は file_write / file_edit のみ (情報収集系・retry 系は通す)
    if (toolName !== "file_write" && toolName !== "file_edit") return null;
    const reasons = this.dialogueLockReasons.length > 0
      ? this.dialogueLockReasons.join(" / ")
      : "対話が必要な状況";
    // ID-003 §2 (2026-04-30): system-prompt から「対話必須ロック」 の存在を説明する文言を
    // 削除した代わりに、 ロック発動時の本エラーで仕様 (発動契機 / 解除条件 / 推奨対応) を
    // 完全に伝える。 file_read の自助エラー (候補/親dir 提示) と同じ性格 — tool 自身の声で
    // 「私は今これを拒否する。 こう対処してください」 を伝える。
    return {
      error:
        `[対話必須ロック] ${toolName} は現在ロックされています。\n` +
        `[発動契機] ${reasons}\n` +
        `\n[次の手] メイン側で ${toolName} を直接実行する前に、 ask_user でユーザーに状況確認してから再試行してください。 3 択を提示するのが基本:\n` +
        `  (a) リトライ — 一時的な失敗だった可能性\n` +
        `  (b) 別アプローチ — 拒否理由が判明したら方針変更\n` +
        `  (c) 中断 — そもそもこのタスクを止める\n` +
        `\n[基本姿勢] まず受け止める → 理由を考える (パスが違う / 内容が違う / 操作ミス / 心変わり / レート制限 等) → 分かれば指示に従う / 分からなければ聞く。 機械的な再試行や独断のフォールバックは禁止。\n` +
        `\n[解除条件] ask_user 呼出で自動解除。 response_complete でも解除 (= ユーザーとの対話/完了の合図)。`,
    };
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
    const toolStartMs = Date.now();

    // Phase 5 第10ラウンド: 対話必須ロック中は file_write/file_edit を tool 層で拒否
    const lockHit = this.checkDialogueLock(toolName);
    let result: import("../tools/tool-registry.js").ToolResult;
    if (lockHit) {
      spinner.fail(chalk.dim(`  ${summary}: 対話必須ロックにより拒否`));
      console.log(chalk.yellow(`  ⛔ ${lockHit.error}`));
      result = { success: false, output: "", error: lockHit.error };
    } else {
      result = await this.toolExecutor.execute(toolCall, this.currentSource);
    }
    const toolDurationMs = Date.now() - toolStartMs;

    // Phase 5 第10ラウンド: 対話必須ロックの発動契機を判定
    this.maybeTriggerDialogueLock(toolName, result);

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

    this.llmLogger.logToolResult({
      toolCallId: toolCall.id,
      toolName,
      rawArguments: toolCall.function.arguments ?? "{}",
      output: result.output ?? "",
      success: result.success,
      error: result.error,
      durationMs: toolDurationMs,
    });

    // ID-001 §2 + §4 (2026-04-30): 段階的開示。 ツール初回使用時にガイドを末尾へ付加。
    // verification / scopeStrict / delegation / secondLLM / obsidian の 5 種が tool-guides.ts に定義されている。
    const guide = getFirstUseGuide(toolCall.function.name);
    if (guide) {
      resultContent += "\n\n" + guide;
    }

    // Phase 5 第2ラウンド: ハーネス介入レイヤ (共通モジュール)。
    // file_edit 連続失敗 / 壁ドンループ / Read→Edit 契約 / 連続委任ガード / 旧エラーガイダンス
    // を一括で適用。
    resultContent = enrichToolResult(toolCall, result.success, resultContent, this.harnessState);

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
        return { toolCall, result: { success: false, output: "", error: "中断されました" }, durationMs: 0 };
      }
      try {
        const summary = formatToolCall(toolCall);
        const startMs = Date.now();
        // Phase 5 第10ラウンド: 並列ルートでも対話必須ロックを尊重
        const lockHit = this.checkDialogueLock(toolCall.function.name);
        let result: import("../tools/tool-registry.js").ToolResult;
        if (lockHit) {
          result = { success: false, output: "", error: lockHit.error };
        } else {
          result = await this.toolExecutor.execute(toolCall, this.currentSource);
        }
        const durationMs = Date.now() - startMs;
        // 対話必須ロックの発動契機を判定 (並列ルート)
        this.maybeTriggerDialogueLock(toolCall.function.name, result);
        const icon = result.success ? chalk.green("✓") : chalk.red("✗");
        const suffix = result.success ? "" : `: ${formatToolError(result.error, result.output)}`;
        console.log(chalk.dim(`  ${icon} ${summary}${suffix}`));
        if (result.success && result.userDisplay) {
          this.renderUserDisplay(result.userDisplay);
        }
        return { toolCall, result, durationMs };
      } finally {
        release();
      }
    });

    const settled = await Promise.allSettled(promises);
    let shouldAbort = false;

    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        const { toolCall, result, durationMs } = entry.value;
        this.llmLogger.logToolResult({
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          rawArguments: toolCall.function.arguments ?? "{}",
          output: result.output ?? "",
          success: result.success,
          error: result.error,
          durationMs,
        });
        let resultContent = result.success
          ? result.output
          : `Error: ${result.error}\n${result.output}`;

        // ID-001 §2 + §4 (2026-04-30): 段階的開示。 並列ルートでも同様にガイドを注入。
        const guide = getFirstUseGuide(toolCall.function.name);
        if (guide) {
          resultContent += "\n\n" + guide;
        }

        // Phase 5 第2ラウンド: ハーネス介入レイヤ (並列ルートでも適用)
        resultContent = enrichToolResult(toolCall, result.success, resultContent, this.harnessState);

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

  /** 現在の会話セッション ID (resume 用)。 ~/.localllm/sessions/ 配下のファイル名と一致。 */
  getCurrentSessionId(): string {
    return this.session.meta.id;
  }

  /** 現在の会話メッセージ数 (system プロンプト等を除く保存対象数)。 */
  getCurrentSessionMessageCount(): number {
    return this.history.getRawMessages().length;
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

// 旧版 enrichToolResult は src/agent/harness-intervention.ts に統合済 (Phase 5 第2ラウンド)。

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


