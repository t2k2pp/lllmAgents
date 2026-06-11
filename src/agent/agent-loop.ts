import chalk from "chalk";
import ora from "ora";
import { AgentEventBus, type TaskOutcome } from "./agent-events.js";
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
import {
  resolveCapability,
  formatCapabilityLabel,
  type CapabilityProfile,
} from "./capability-tier.js";
import { normalizeToolCalls } from "./tool-call-normalizer.js";
import {
  classifyTaskComplexity,
  recommendTier,
  explainRecommendation,
} from "./task-complexity.js";
import { buildSystemPrompt, type SkillInfo, type LLMProfiles, type SystemPromptOverrides } from "./system-prompt.js";
import { compressText } from "./compress-text.js";
import { loadMemory } from "./memory.js";
import { loadProjectInstructions } from "./project-context.js";
import {
  createSession,
  saveSession,
  type SessionData,
} from "./session-manager.js";
import { PlanManager } from "./plan-mode.js";
import type { SamplingParams } from "../config/types.js";
import { loadConfig } from "../config/config-manager.js";
import { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import * as logger from "../utils/logger.js";
import { getOpsLogger } from "../utils/ops-logger.js";
import { LLMLogger } from "./llm-logger.js";
import { isStructurallyIncomplete } from "../utils/incomplete-response.js";
import { formatToolCall, formatToolError } from "../cli/tool-summary.js";
import { getFirstUseGuide, getFailureGuide } from "./tool-guides.js";
import { IntentClassifier } from "./intent-classifier.js";
import { Evaluator } from "./evaluator.js";
import { judgeProgress, buildRecentSummary } from "./progress-judge.js";
import { checkCoherence, buildCoherenceNudge } from "./coherence-check.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
import type { ChatLogger } from "./chat-logger.js";
import { renderEditDiff, renderWriteDiff } from "../cli/diff-display.js";
import {
  type GoalDefinition,
  setGoal as setGoalSlot,
  getGoal as getGoalSlot,
  clearGoal as clearGoalSlot,
  hasGoal as hasGoalSlot,
  buildGoalSlotSection,
  getEvaluationHistory,
  restoreGoalState,
} from "./goal-slot.js";
import {
  setTodos as setTodosFromGoal,
  getTodos as getTodosCurrent,
  clearTodos,
  buildTodoSection,
  formatTodos,
} from "../tools/definitions/todo-write.js";

/**
 * AgentMode — paradigm 軸の切替。 register (style 軸) と直交。
 * docs/goal-seek-mode-design.md §2.1 参照。
 */
export type AgentMode = "forward" | "goal-seek";

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

/**
 * 反復上限の絶対 hard cap。 Phase C 以降は capability.maxIterations が
 * 主要な制御点となり、 この定数は実際には使われない (一律 100 に統一)。
 * 残してあるのは過去ドキュメントとの整合性 (DESIGN.md / docs/internal_design.md)。
 */
const MAX_TOOL_ITERATIONS = 100;
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

/**
 * P2-B + Phase C-3: 巨大 tool_result を頭尾要約に置換する。
 *
 * - 閾値: tier 別 (T1=20KB / T2=12KB / T3=6KB)。 短 ctx の T3 はノイズ感受性高。
 * - 加工: 先頭 60% + 末尾 30% を残し、 中央を「...(N bytes truncated for history)」 に置換
 * - 対象外: file_edit (P0-B で自前にスニペット同梱しており短い)、 file_write
 *
 * docs/agent-loop-efficiency-review.md §4.8 / docs/multi-tier-harness-roadmap.md §4 Phase C 参照。
 */
function truncateLargeToolResult(toolName: string, content: string, threshold: number): string {
  if (!content) return content;
  // file_edit は P0-B で自前にスニペット同梱しており、 既に短い
  if (toolName === "file_edit" || toolName === "file_write") return content;
  if (content.length <= threshold) return content;
  // 閾値の 60%/30% で頭尾、 残り 10% は truncate メッセージ
  const headBytes = Math.floor(threshold * 0.6);
  const tailBytes = Math.floor(threshold * 0.3);
  const head = content.slice(0, headBytes);
  const tail = content.slice(-tailBytes);
  const truncated = content.length - headBytes - tailBytes;
  return (
    head +
    `\n\n...(${truncated} bytes truncated for history; full output was ${content.length} bytes from "${toolName}")...\n\n` +
    tail
  );
}


export class AgentLoop {
  private history: MessageHistory;
  private contextManager: ContextManager;
  private toolExecutor: ToolExecutor;
  private session: SessionData;
  private planManager: PlanManager | null = null;
  /** Discord Interaction Server などから並行処理を避けるためのフラグ */
  public isProcessing = false;
  /**
   * イベント境界 (docs/agent-events-design.md)。 Slack/Discord 等のチャネルアダプタが
   * 購読する。 Phase 1 では CLI 表示は従来どおりインラインで行い、 同じ地点から併発する。
   */
  public readonly events = new AgentEventBus();
  /** 現在の run() の統計 (task_complete イベント用)。 run() 冒頭でリセット */
  private runStats = {
    startMs: 0,
    iterations: 0,
    toolsExecuted: 0,
    finalText: "",
    outcome: "incomplete" as TaskOutcome,
  };
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
  /**
   * P0-A: 直近 FAILURE_WINDOW 反復内のツール失敗履歴。 同じ (signature, error) が
   * 2 回以上出たら「同じ轍を踏んでいる」 と判定し self-check を注入する。
   * 既存の MAX_REPEAT_TOOL=3 (連続検出) では grep/read を間に挟まれると無効化されるため、
   * sliding window で「間に他ツールが挟まっても」 失敗の繰り返しを検出する補強。
   */
  private recentFailures: Array<{ iteration: number; signature: string; error: string }> = [];
  /** 主ループの現在の iteration index (executeSingleTool/Parallel から参照するため共有) */
  private currentIteration = 0;
  /**
   * P1-A: bash 累積実行時間 (ms)。 重い build/run の連発を抑止するための観測値。
   * 閾値超過で 1 度だけ警告を末尾に注入し、 ユーザー発話で reset。
   */
  private bashCumulativeMs = 0;
  /** P1-A: bash 警告を既に注入したか (1 user span に 1 回だけ) */
  private bashCumulativeWarned = false;
  /** P1-B: 1 user span 内の enter_plan_mode 呼出回数 */
  private planModeEntries = 0;
  /** P1-B: 1 user span 内の todo_write 呼出回数 */
  private todoWriteCount = 0;
  /** P1-B: plan/todo の過多警告を既に注入したか (1 user span に 1 回だけ) */
  private planTodoWarned = false;
  /**
   * P3-A: 現在の対話レジスター。 system-prompt の規約により、 モデルがタスク開始時に
   * 「このタスクは X として進めます」 と宣言する。 その宣言を読み取り、 反復上限を
   * レジスター別に切り替える。 unknown のままなら従来通り MAX_TOOL_ITERATIONS=100。
   */
  private currentRegister: "explore" | "rough" | "standard" | "production" | "unknown" = "unknown";
  /** P3-A: ソフトキャップ警告を既に注入したか (1 user span に 1 回だけ) */
  private softCapWarned = false;
  /**
   * Goal Seek mode: paradigm 軸。 register (style 軸) と直交した別軸。
   * 切替は user 明示のみ (enterGoalSeek / exitGoalSeek)。 AI 自動判定は不可。
   * docs/goal-seek-mode-design.md §2.2 参照。
   */
  private currentMode: AgentMode = "forward";
  // 注: 旧 basePrompt フィールドは戦略 ToDo Phase 1 で撤去。
  // 準システムプロンプト合成は composer 経由で行い、 base は MessageHistory が保持する this.systemPrompt
  // が単一の真実源 (composer の base 引数で渡される)。
  /**
   * Phase A: 能力ティアプロファイル。 ハーネス各機能はこれを参照して挙動を切替える。
   * docs/multi-tier-harness-roadmap.md §3 参照。
   * 主流路 (P0-P3) との統合は Phase A-7 (後続コミット) で実施予定。
   * 現時点では起動ログと /capability コマンドへの可視化のみ。
   */
  private capability: CapabilityProfile;
  /** チャットログ（Obsidian Vault保存、null なら無効） */
  private chatLogger: ChatLogger | null = null;
  /** Evaluator（成果物の独立レビュー） */
  private evaluator: Evaluator;
  /** LLMプロファイル情報（システムプロンプト再構築用。/model description 等の更新時に差し替え可） */
  private llmProfiles?: LLMProfiles;
  /** システムプロンプト再構築に必要な構築時パラメータ (opt-in 入力圧縮の再ビルド用に保持) */
  private builtSkills?: SkillInfo[];
  private builtHasSecondLLM = false;
  private builtHasObsidian = false;
  /** opt-in 入力圧縮モードの有効状態。 docs/input-compression-design.md */
  private inputCompressionEnabled = false;
  /** 直近の圧縮結果 (/context 可視化用)。 原文と圧縮済みテキストの両方を保持する */
  private compressionState: Array<{
    label: string;
    original: string;
    /** 圧縮済みテキスト (applied=true のときのみ)。 再ビルド時に LLM 再呼出なしで overrides を復元するため保持 */
    compressedText?: string;
    beforeTokens: number;
    afterTokens: number;
    applied: boolean;
    note?: string;
  }> = [];
  /** 自動チェックポイント (シャドウ Git)。 docs/checkpoint-and-smoke-design.md §4 */
  private checkpointManager: CheckpointManager;

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
    this.builtSkills = skills;
    this.builtHasSecondLLM = hasSecondLLM;
    this.builtHasObsidian = hasObsidian;
    // Phase A-3 + A-5: 能力ティア解決 (model + ctx 窓 + config の override)
    this.capability = resolveCapability(model, contextWindow, this.getCapabilityOverride(model));
    logger.info(`[capability] ${formatCapabilityLabel(this.capability, model)} (${this.capability.reason})`);
    // Phase B-2: 能力ティアを system prompt に渡して、 T1=concise / T2=current / T3=verbose+examples を出し分ける
    const systemPrompt = buildSystemPrompt(skills, hasSecondLLM, hasObsidian, llmProfiles, this.capability.tier);
    // 既存 goal-slot 状態を反映 (process 内で /goal-seek 実行後の AgentLoop 再生成時に継承)。
    if (hasGoalSlot()) {
      this.currentMode = "goal-seek";
    }
    // 戦略 ToDo Phase 1 (docs/strategic-todo-design.md §2.2 / §3.1):
    // 準システムプロンプト動的合成。 base + goal section + todo section を毎呼出で fresh に作る。
    // composer は MessageHistory.getMessages() が呼ぶたびに最新の goal-slot / todos を読んで合成。
    this.history = new MessageHistory(systemPrompt);
    this.history.setSystemPromptComposer((base) => this.composeQuasiSystemPrompt(base));
    // Phase C-2 + D-4: 圧縮閾値と keepRecentMessages を tier 由来で設定。
    // 引数の compressionThreshold は無視され、 capability の値が常に勝つ。
    // (ユーザが明示的に変えたい場合は config.json modelCapabilities.<modelId>.* で override 可能)
    void compressionThreshold; // 後方互換: 引数は受け付けるが capability 由来を使う
    this.contextManager = new ContextManager(
      provider,
      model,
      contextWindow,
      this.capability.compressionThreshold,
      this.capability.keepRecentMessages,
    );
    // 自動チェックポイント。 main ループのみで版管理する。
    // スコープは成果物フォルダ限定 (設計書 §4.5): 既定は <cwd>/sandbox/output、 無ければ cwd。
    // 既定の有効化: 明示設定があればそれ。 未設定なら「成果物フォルダに解決できた時のみ ON」
    // (cwd 全体= 開発リポジトリ等になる時は OFF にして、 無関係なソースを勝手に撮らない)。
    const cpCfg = loadConfig().checkpoints;
    const cpWorkTree = CheckpointManager.resolveWorkTree(process.cwd(), cpCfg?.workTreeDir);
    const cpScopedToArtifact = cpCfg?.workTreeDir != null || cpWorkTree !== process.cwd();
    this.checkpointManager = new CheckpointManager({
      sessionId: sessionId ?? "default",
      workTree: cpWorkTree,
      enabled: cpCfg?.enabled ?? cpScopedToArtifact,
      retention: cpCfg?.retention,
      maxFileSizeMb: cpCfg?.maxFileSizeMb,
    });
    // ※ 古いセッションの掃除 (pruneOldSessions) は、 resume でセッション identity が
    //    確定した後に runCheckpointMaintenance() で実行する (復元対象を誤って消さないため)。
    this.toolExecutor = new ToolExecutor(
      toolRegistry,
      permissions,
      hookManager,
      undefined,
      this.checkpointManager,
    );
    // claude-agent-sdk プロバイダの場合、 lllmAgent ツールを in-process MCP として
    // SDK に公開する (docs/claude-agent-sdk-provider-design.md §3.3)。
    // duck typing で attach メソッドを持つプロバイダのみに適用。
    const bridgeable = provider as unknown as {
      attachToolBridge?: (r: ToolRegistry, e: ToolExecutor) => void;
    };
    if (typeof bridgeable.attachToolBridge === "function") {
      bridgeable.attachToolBridge(toolRegistry, this.toolExecutor);
    }
    this.session = createSession(model);
    // チェックポイントは resume を跨いで安定な session.meta.id で採番する (H1)
    this.checkpointManager.rebind(this.session.meta.id);
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

  /** harness_notice イベントの発火ヘルパー (CLI 表示とは独立。 docs/agent-events-design.md §3) */
  private notice(level: "info" | "warn" | "error", message: string): void {
    this.events.emit("harness_notice", { level, message });
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
    this.runStats = {
      startMs: Date.now(),
      iterations: 0,
      toolsExecuted: 0,
      finalText: "",
      outcome: "incomplete",
    };
    this.events.emit("task_start", {
      source: this.currentSource,
      prompt: typeof userMessage === "string"
        ? userMessage
        : userMessage
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join(" "),
      timestamp: this.runStats.startMs,
    });
    // P0-A: ユーザー発話のたびに失敗履歴をリセット (前ターンの失敗を引き摺らない)
    this.recentFailures = [];
    // P1-A/B: bash累積時間 / plan/todo 呼出回数も user span 単位でリセット
    this.bashCumulativeMs = 0;
    this.bashCumulativeWarned = false;
    this.planModeEntries = 0;
    this.todoWriteCount = 0;
    this.planTodoWarned = false;
    // P3-A: レジスターは user 発話ごとに再判定 (前タスクのレジスターを引き継がない)
    this.currentRegister = "unknown";
    this.softCapWarned = false;
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
    // Phase E-3: タスク複雑度を分類して、 不一致なら model 推奨を 1 行ログ。
    // 自動切替はしない (ユーザの明示操作 = /model を尊重)。
    try {
      const complexity = classifyTaskComplexity(userMessageText);
      const recommended = recommendTier(complexity, this.capability.tier);
      if (recommended) {
        const reason = explainRecommendation(complexity, this.capability.tier, recommended);
        console.log(chalk.dim(
          `  [model 推奨] ${this.capability.tier} → ${recommended} (complexity=${complexity}). ${reason}`,
        ));
        console.log(chalk.dim(`  → 切替する場合: /model <name> または /second swap`));
      }
    } catch { /* 推奨は best-effort、 失敗しても続行 */ }
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
    // Phase C-2: tier 別に自己点検回数を変える。 T1=3 / T2=2 / T3=1。
    // T3 は scaffolding を増やしても改善しないため早めにユーザに戻す。
    const MAX_SELF_CHECK_ROUNDS = this.capability.maxSelfCheckRounds;
    const MAX_REPEAT_TOOL = 3; // 同じツール呼び出しがN回連続で失敗したら中断

    // 2026-05-16 (docs/strategic-todo-design.md 議論): base harness の persistence 機構。
    // 既存 self-check と独立した並列カウンタ。 standard 以上のレジスターでのみ発火。
    let progressGateRetries = 0;        // Axis (1) Q→A 進捗 gate (response_complete 時)
    let coherenceGateRetries = 0;       // Axis (2a) thinking-text コヒーレンス
    const MAX_NEW_GATE_RETRIES = 2;     // 各 gate の上限 (自己点検と独立)

    // Phase C-2: hard cap を tier 別に。 T1=100, T2=80, T3=50。
    // ユーザー override (config.json modelCapabilities) で上書きも可能。
    const hardCap = this.capability.maxIterations;
    for (let iteration = 0; iteration < hardCap; iteration++) {
      this.currentIteration = iteration;
      this.runStats.iterations = iteration + 1;
      // P3-A: レジスター別ソフトキャップ。 hard cap (= capability.maxIterations) 内で、
      // 軽量タスク (explore/rough) は早めに上限到達を促し、 standard はやや控えめ。
      // Phase C-4: production が hard cap (T3=50) を超えないよう min を取る。
      const softCap = Math.min(this.computeRegisterSoftCap(), hardCap);
      if (iteration >= softCap && !this.softCapWarned) {
        console.log(chalk.yellow(
          `\n  完了レベル "${this.currentRegister}" のソフト上限 (${softCap}) に到達しました。 ` +
          `必要なら ask_user で続行可否を確認するか、 区切って報告してください。`,
        ));
        this.notice("warn", `完了レベル "${this.currentRegister}" のソフト上限 (${softCap} 反復) に到達`);
        this.history.addUserMessage(
          `[ハーネス] 完了レベル "${this.currentRegister}" のソフト上限 (${softCap} 反復) に到達しました。\n` +
          `  進捗を簡潔にまとめ、 残作業を提示してから ask_user で続行 or 中断を確認してください。\n` +
          `  「もう少しで終わる」 と判断するなら response_complete で完了報告を。 hard cap は ${hardCap} 反復です (tier=${this.capability.tier})。`,
        );
        this.softCapWarned = true;
        // ソフトキャップ到達後は hard cap までしか走らないようループ条件で自然終了させる
        // (即座に return せず、 LLM の応答を 1 回受けてから安全に閉じる)
      }
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
          // maxTokens は意図的に渡さない:
          //   - openai-compat (Azure Foundry / vLLM 等): 省略すると「残りコンテキスト全部」がサーバ既定値となる。
          //     contextWindow をそのまま渡すと、サーバによっては input + max_tokens > context で 400 を返す
          //     (例: Kimi-K2 で 13991 input + 256000 max_tokens > 262144 → BadRequest)。
          //   - azure-anthropic: max_tokens 必須だが provider 側に DEFAULT_MAX_TOKENS=64000 のフォールバックあり。
          //   - azure-gpt (Responses API): max_output_tokens 省略時はサーバ既定 (= 残コンテキスト) が適用される。
          const gen = toolDefs.length > 0
            ? this.provider.chatWithTools({
              model: this.model,
              messages: this.history.getMessages(),
              tools: toolDefs,
              stream: true,
              ...this.samplingParams,
            })
            : this.provider.chat({
              model: this.model,
              messages: this.history.getMessages(),
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

          // 「考え中…」 スピナーに経過時間を表示するためのヘルパー。
          // thinking フェーズが長引いても進捗が見える (2026-05-14 修正)。
          let thinkingStartTime = 0;
          let thinkingTimer: ReturnType<typeof setInterval> | null = null;
          const startThinkingSpinner = (): void => {
            if (thinkingSpinner) return;
            thinkingStartTime = Date.now();
            thinkingSpinner = ora(chalk.dim("  考え中...")).start();
            thinkingTimer = setInterval(() => {
              if (thinkingSpinner) {
                const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
                thinkingSpinner.text = chalk.dim(`  考え中... (${formatElapsed(elapsed)})`);
              }
            }, 1000);
          };
          const stopThinkingSpinner = (failMessage?: string): void => {
            if (thinkingTimer) {
              clearInterval(thinkingTimer);
              thinkingTimer = null;
            }
            if (thinkingSpinner) {
              if (failMessage !== undefined) {
                thinkingSpinner.fail(failMessage);
              } else {
                thinkingSpinner.stop();
              }
              thinkingSpinner = null;
            }
          };

          for await (const chunk of abortableIterator(gen, () => this._aborted)) {
            if (this._aborted) {
              stopWaitingSpinner();
              stopThinkingSpinner();
              if (this.streamingDisplay && hasStartedOutput) process.stdout.write("\n");
              console.log(chalk.yellow("\n  (処理を中断しました)"));
              this.purgeEphemeralAtSpanEnd("user_abort");
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
                    // スピナーモード: "考え中... (Xs)" スピナー (経過時間付き)
                    startThinkingSpinner();
                  }
                  thinkingContent += chunk.text;
                }
                break;
              case "text":
                if (chunk.text) {
                  stopWaitingSpinner();
                  if (this.streamingDisplay) {
                    // ストリーミングモード: リアルタイム表示
                    stopThinkingSpinner();
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
                    // 「考え中…」 から「受信中…」 への切替なので thinkingTimer も止める
                    stopThinkingSpinner();
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
                // 待機スピナー + thinking スピナーを停止
                stopWaitingSpinner();
                stopThinkingSpinner();
                if (chunk.toolCall) {
                  toolCalls.push(chunk.toolCall);
                }
                break;
              case "error":
                stopWaitingSpinner();
                stopThinkingSpinner("エラー");
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
                  // プロンプトキャッシュヒット分 (provider が報告すれば) を割引単価で計上。
                  // 報告が無い (=0) なら従来どおり全額。 docs/cost-token-command-design.md §3
                  const cachedTokens = chunk.usage.cachedTokens ?? 0;
                  const cost = globalCostCalculator.calculateForModelWithCache(
                    this.model,
                    chunk.usage.promptTokens ?? 0,
                    chunk.usage.completionTokens ?? 0,
                    cachedTokens,
                  );
                  globalTokenTracker.record({
                    timestamp: new Date().toISOString(),
                    provider: this.provider.providerType,
                    model: this.model,
                    slot: "main",
                    inputTokens: chunk.usage.promptTokens ?? 0,
                    outputTokens: chunk.usage.completionTokens ?? 0,
                    cachedTokens,
                    estimatedCostUsd: cost,
                    sessionId: this.session.meta.id
                  });
                }
                stopWaitingSpinner();
                stopThinkingSpinner();
                break;
            }
          }

          // ストリーム完了後もスピナーが残っていたらクリーンアップ
          stopWaitingSpinner();
          stopThinkingSpinner();

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
            this.notice("warn", `接続エラー: ${err.message} — リトライ ${connectionRetries}/${MAX_CONNECTION_RETRIES}`);
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
          this.notice("error", `LLM 呼び出しエラー: ${err.message}`);
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
            this.purgeEphemeralAtSpanEnd("llm_error_abort");
            return;
          }
        }
      }

      if (!success) {
        this.purgeEphemeralAtSpanEnd("llm_call_unsuccessful");
        return;
      }

      // P3-A: アシスタント応答テキストからレジスター宣言を検出 (1 user span に 1 度だけ反映)
      this.detectRegisterFromText(textContent);

      // 応答テキストの遅延表示ヘルパー (docs/spinner-mode-response-coloring-design.md)。
      // スピナーモードでは「このターンが続くか終わるか」 を判定してから色を決める:
      //   - dim=true : 中間ナレーション (ツール前の「〜します」/ 自己点検で継続する中間テキスト) → 灰色
      //   - dim=false: ユーザーへの最終応答 → 白/Markdown
      // assistantTextFlushed で 1 イテレーションにつき 1 回だけ表示する。
      let assistantTextFlushed = false;
      const flushAssistantText = (dim: boolean): void => {
        if (assistantTextFlushed) return;
        const filteredText = createThinkingFilter()(textContent);
        if (!filteredText.trim()) return;
        assistantTextFlushed = true;
        // イベントは表示モードに依存せず発火する (チャネル購読者向け)。
        // final=true (白表示相当) はユーザー向け最終応答として task_complete にも載せる。
        this.events.emit("assistant_text", { text: filteredText, final: !dim });
        if (!dim) this.runStats.finalText = filteredText;
        // CLI 表示: ストリーミングモードはライブ出力済みのためここでは表示しない
        if (this.streamingDisplay || !hasStartedOutput) return;
        if (dim) {
          const indented = filteredText.split("\n").map((l) => "  " + l).join("\n");
          console.log("\n" + chalk.dim(indented));
        } else if (hasMarkdown(filteredText)) {
          console.log(renderMarkdown(filteredText));
        } else {
          console.log("\n" + filteredText);
        }
      };

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
        // 部分応答を一旦履歴に積んで「続き」 を促すが、 これは in-turn の継続合図なので
        // ユーザー応答完了時に purge して context を綺麗にする (tool_calls がある場合は永続化)。
        this.history.addAssistantMessage(
          textContent,
          toolCalls.length > 0 ? toolCalls : undefined,
          { ephemeral: toolCalls.length === 0, thinking: thinkingContent },
        );
        this.history.addUserMessage(
          "続きを出力してください。途中から再開してください。",
          { ephemeral: true },
        );
        continue;
      }

      // Phase D-1: 非標準形式 (Mistral [TOOL_CALLS] / ChatML <tool_call> / Anthropic XML /
      // ReAct Action: / Plain JSON / pipe-call) の tool 呼び出しを fallback として正規化する。
      // 2026-05-13: 当初は T2/T3 限定だったが、 gpt-5.x reasoning モードが thinking/text に
      // <tool_call><function=...><parameter=...> を書き出す事例 (2026-05-12 観測) があるため
      // T1 でも有効化。 toolCalls.length === 0 のときのみ動くので native function calling と競合しない。
      //
      // 2026-06-07: この正規化を「ツール実行ブロックより前」 に移動 (バグ修正)。 旧版は実行
      // ブロック (下方の `if (toolCalls.length > 0)`) の *後* に置かれていたため、 thinking/text
      // から救出した tool 呼び出しが ops ログには記録されるのに *一度も実行されず* に空応答として
      // ターンが終わる致命的欠陥があった (session mq34du2c: Qwen3.6 が reasoning_content に
      // second_llm_consult を正しく書いたのにしりとりが一手も進まなかった事例)。 抽出した
      // toolCalls を flush / coherence / 実行 の手前で確定させ、 既存の実行ルートに合流させる。
      // docs/tool-call-salvage-pipe-format-design.md §6 参照。
      if (toolCalls.length === 0 && textContent.trim().length > 0) {
        const normalized = normalizeToolCalls(textContent);
        if (normalized.toolCalls.length > 0) {
          console.log(chalk.dim(
            `  [tool-format] ${normalized.format} 形式から ${normalized.toolCalls.length} 件の tool 呼び出しを抽出 (tier=${this.capability.tier})`,
          ));
          // 非TTY / --background では console が見えないため、 ops-logger に構造化記録を残す
          // (誤発火・発火頻度の事後調査用。 全形式共通)。
          getOpsLogger().info("tool-format", "テキストから tool 呼び出しを正規化抽出", {
            format: normalized.format,
            toolCount: normalized.toolCalls.length,
            toolNames: normalized.toolCalls.map((tc) => tc.function.name),
            source: "text",
            tier: this.capability.tier,
          });
          // 既存の textContent / toolCalls を上書きして tool 実行ルートへ流す。
          // textContent を cleanedText に差し替えるので、 直後の flushAssistantText(true) と
          // 実行ブロックの addAssistantMessage は非標準マーカーを除去済みの本文を使う。
          textContent = normalized.cleanedText;
          toolCalls.push(...normalized.toolCalls);
        }
      }

      // Phase 2: 思考保全 — text/toolCalls がともに空でも thinking 内に <tool_call> 等が
      // 埋まっているケース (例: Qwen3 が reasoning_content に ChatML 形式、
      // gpt-5.x reasoning が Anthropic XML 形式を吐く) を救う。
      // 思考は SoWhat/WhySo の核なので、 そこに完成形のツールコールがあるなら捨てずに実行する。
      // docs/ephemeral-context-design.md §7.2 参照。
      if (toolCalls.length === 0 && thinkingContent.trim().length > 0) {
        const normalized = normalizeToolCalls(thinkingContent);
        if (normalized.toolCalls.length > 0) {
          console.log(chalk.dim(
            `  [tool-format] thinking 内 ${normalized.format} 形式から ${normalized.toolCalls.length} 件の tool 呼び出しを抽出 (tier=${this.capability.tier})`,
          ));
          getOpsLogger().info("tool-format", "thinking から tool 呼び出しを正規化抽出", {
            format: normalized.format,
            toolCount: normalized.toolCalls.length,
            toolNames: normalized.toolCalls.map((tc) => tc.function.name),
            source: "thinking",
            tier: this.capability.tier,
          });
          // toolCalls が空の場合 (textContent の有無は問わない) に thinking 内のツール呼び出しを
          // 救出する。 textContent は通常空だが、 上の text salvage がツールを抽出できなかった
          // (normalized.toolCalls.length===0) 場合は非空のまま到達しうる。 toolCalls を追加すれば
          // 実行ブロックの addAssistantMessage(textContent, toolCalls, ...) が textContent も正しく永続化する。
          toolCalls.push(...normalized.toolCalls);
        }
      }

      // ツール呼び出しを伴うテキストは「これから〜する」 という中間ナレーションと確定 → 灰色で表示。
      // ツールを伴わないテキストは「最終応答」 か「自己点検で継続する中間」 か未確定なので、
      // ここでは出さず下流のディスポジション地点 (最終応答=白 / 自己点検=灰色) で flush する。
      if (toolCalls.length > 0) {
        flushAssistantText(true);
      }

      // 2026-05-16: Axis (2a) thinking-text コヒーレンス検査。
      // standard 以上のレジスターでのみ発火。 model が thinking で「続きある」 と書いているのに
      // text/response_complete で「完了」 を宣言しているズレを拾う。
      // - 緩めの regex パターン (兆候レベルで拾う)
      // - LLM 呼出なし (軽量)
      // - 検出時は ephemeral nudge を inject、 retry counter 制限あり
      {
        const isStandardOrUp = this.isStandardOrAboveRegister();
        // toolCalls がある場合 (native / salvage 由来とも) は実行を優先し coherence nudge を
        // 出さない。 さもないと続行意図のツール呼び出しを「完了ズレ」 と誤判定して drop し continue
        // してしまう (2026-06-07: salvage 移動に伴う取りこぼし防止)。
        if (toolCalls.length === 0 && isStandardOrUp && coherenceGateRetries < MAX_NEW_GATE_RETRIES) {
          // この時点で toolCalls は空 (上の length===0 ガード) なので response_complete は無い。
          // hasRC を toolCalls.some(...) で計算すると常に false の死蔵コードになり、 ガードを
          // 変えた未来のメンテナがロジックを誤解する恐れがあるため false 固定で意図を明示する。
          const hasRC = false;
          const coherence = checkCoherence(thinkingContent, textContent, hasRC);
          if (coherence.mismatch) {
            coherenceGateRetries++;
            console.log(chalk.yellow(
              `  [coherence ${coherenceGateRetries}/${MAX_NEW_GATE_RETRIES}] thinking「${coherence.continuationHit}」 vs 完了「${coherence.completionHit}」 ズレ検出`,
            ));
            // 元 response は履歴に積まずに (= 完了宣言を確定させず)、 nudge だけ inject して loop 続行
            this.history.addAssistantMessage(textContent, undefined, { ephemeral: true, thinking: thinkingContent });
            this.history.addUserMessage(buildCoherenceNudge(coherence), { ephemeral: true });
            continue;
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
            this.history.addAssistantMessage(textContent, toolCalls, { thinking: thinkingContent });
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

        this.history.addAssistantMessage(textContent, toolCalls, { thinking: thinkingContent });

        let shouldAbort = false;
        if (toolCalls.length === 1) {
          shouldAbort = await this.executeSingleTool(toolCalls[0]);
        } else {
          shouldAbort = await this.executeToolsParallel(toolCalls);
        }

        if (shouldAbort) {
          this.purgeEphemeralAtSpanEnd("tool_abort");
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
                    "設計書（.md等）の作成はプランモード中でも問題ありません。",
                    { ephemeral: true },
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
          let forceFlag = false;
          try {
            const args = JSON.parse(rcCall.function.arguments ?? "{}");
            summary = (args.summary as string) ?? "";
            forceFlag = (args.force as boolean) ?? false;
          } catch { /* ignore */ }
          if (summary.length > 0) {
            // summary はユーザーへの最終応答 → イベント + task_complete の finalResponse に採用。
            this.events.emit("assistant_text", { text: summary, final: true });
            this.runStats.finalText = summary;
            // docs/spinner-mode-response-coloring-design.md
            // スピナーモード: 白/Markdown で表示 (narration は toolCalls 経路で灰色 flush 済み)。
            // ストリーミングモード: 本文は既にライブ出力済みなので二重表示を避け従来どおり灰色サマリ。
            if (this.streamingDisplay) {
              console.log("\n" + chalk.dim(`  [response_complete] ${summary}`));
            } else {
              console.log("\n" + (hasMarkdown(summary) ? renderMarkdown(summary) : summary));
            }
          }
          // Goal Seek mode: acceptance 充足で span 終了したら自動的に mode を抜ける。
          // (todo gate は response-complete.ts で実施済み。 ここに来た = ゲート通過 = 全 criteria 完了 or force)
          // 設計書 §3.6 — 完了経路 (1) all criteria met → exit
          if (this.currentMode === "goal-seek") {
            const todos = getTodosCurrent();
            const allDone = todos.length > 0 && todos.every((t) => t.status === "completed");
            if (allDone) {
              console.log(chalk.green(`  ✓ Goal Seek: acceptance 全項目達成 — mode 終了`));
              this.exitGoalSeek("completed");
            } else if (forceFlag) {
              console.log(chalk.yellow(`  ⚠ Goal Seek: force=true で強制完了 — mode 終了 (acceptance 未充足)`));
              this.exitGoalSeek("abort");
            }
            // それ以外 (todos 0 件 等) は mode を抜けず保持。 次の span でも goal を継続。
          }

          // 2026-05-16: Axis (1) Q→A 進捗 gate (docs/strategic-todo-design.md 議論)。
          // standard 以上のレジスターで、 force=false の時のみ発火。
          // sub-agent パターンで isolated に「本当に Q に答えたか?」 を判定し、
          // stalled なら span 終了させず ephemeral nudge を inject して継続。
          const isStandardOrUp = this.isStandardOrAboveRegister();
          if (
            isStandardOrUp &&
            !forceFlag &&
            progressGateRetries < MAX_NEW_GATE_RETRIES
          ) {
            const recentSummary = buildRecentSummary(this.history.getRawMessages(), 5);
            const judge = await judgeProgress({
              originalUserMessage: userMessageText,
              recentSummary,
              latestResponse: { text: textContent, toolCalls },
              provider: this.provider,
              model: this.model,
            });
            if (judge.verdict === "stalled") {
              progressGateRetries++;
              console.log(chalk.yellow(
                `  [Q→A gate ${progressGateRetries}/${MAX_NEW_GATE_RETRIES}] stalled — ${judge.reason.slice(0, 100)}`,
              ));
              this.history.addUserMessage(
                `[ハーネス] 完了宣言を受けましたが、 Q→A 進捗判定で **stalled** と判断されました。\n` +
                `理由: ${judge.reason}\n\n` +
                `# 元の Q (北極星)\n${userMessageText.slice(0, 300)}${userMessageText.length > 300 ? "..." : ""}\n\n` +
                `元 Q への進捗を実質的に進めてください。 必要なら ToDo を再確認し、 該当する実装 tool を呼ぶか ` +
                `(${MAX_NEW_GATE_RETRIES - progressGateRetries + 1} 回まで再判定可、 その後は force=true で強制完了可能)。`,
                { ephemeral: true },
              );
              // tool_call として response_complete は既に履歴に積まれているが、 span は終わらせず continue
              continue;
            }
            if (judge.verdict === "took_step") {
              console.log(chalk.dim(`  [Q→A gate] took_step — ${judge.reason.slice(0, 100)}`));
            }
            // answered or took_step なら span 終了に進む
          }

          // span 境界: in-turn の harness 注入 (self-check / nudge / 空応答 placeholder 等) を破棄。
          // 過去 span のノイズを次 span に持ち込まない。 docs/ephemeral-context-design.md 参照。
          this.purgeEphemeralAtSpanEnd("response_complete");
          return;
        }

        continue;
      }

      // ガベージ応答（トークンアーティファクト等）を検出: リプロンプトしても改善しないため中断
      // 注: 上の正規化で tool calls を抽出できた場合はここに来ない (toolCalls.length > 0)
      if (toolCalls.length === 0 && textContent.trim().length > 0 && isGarbageResponse(textContent)) {
        console.log(chalk.yellow("\n  モデルの応答が解析できない形式です。プロンプトを変えて再度お試しください。"));
        this.history.addAssistantMessage(textContent, undefined, { thinking: thinkingContent });
        this.purgeEphemeralAtSpanEnd("garbage_response");
        return;
      }

      // 検証未実施チェック: コードファイルを書いた後にbashを呼ばずにテキスト応答した場合
      if (toolCalls.length === 0 && pendingVerification.length > 0 &&
          selfCheckRounds < MAX_SELF_CHECK_ROUNDS &&
          !this.planManager?.isInPlanMode()) {
        selfCheckRounds++;
        flushAssistantText(true); // 継続する中間テキスト = 灰色
        const fileList = pendingVerification.map(f => `    - ${f}`).join("\n");
        console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] 検証未実施`));
        this.notice("info", `[自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] 検証未実施`);
        // 中間 promise テキストと self-check nudge は in-turn 専用 (応答完了時に purge)
        // thinking も保全 (span 内で活用、 span 終了時に破棄)
        this.history.addAssistantMessage(textContent, undefined, { ephemeral: true, thinking: thinkingContent });
        this.history.addUserMessage(
          formatSelfCheck(
            selfCheckRounds, MAX_SELF_CHECK_ROUNDS, userMessageText,
            `以下のファイルの動作確認が未完了です:\n${fileList}\n` +
            `    bash で検証コマンドを実行してください（.ts/.js: node --check, .py: python -m py_compile, プロジェクト全体: build/test/lint）。\n` +
            `    注意: GUIアプリ(pygame等)は構文チェックのみ。直接起動するとタイムアウト。`
          ),
          { ephemeral: true },
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
          flushAssistantText(true); // 継続する中間テキスト = 灰色
          const feedback = Evaluator.formatForInjection(result);
          console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] Evaluator不合格`));
          this.notice("info", `[自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] Evaluator不合格`);
          // Evaluator 指摘と中間応答は in-turn 専用、 thinking も保全
          this.history.addAssistantMessage(textContent, undefined, { ephemeral: true, thinking: thinkingContent });
          this.history.addUserMessage(
            formatSelfCheck(
              selfCheckRounds, MAX_SELF_CHECK_ROUNDS, userMessageText,
              `Evaluatorから以下の指摘があります:\n${feedback}`
            ),
            { ephemeral: true },
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
          // 上限到達: ユーザーに報告して中断。 ここで turn が終わるので最終応答として白で表示。
          flushAssistantText(false);
          console.log(chalk.yellow(`\n  自己点検を${MAX_SELF_CHECK_ROUNDS}回実施しましたが response_complete が呼ばれませんでした。`));
          this.history.addAssistantMessage(textContent, undefined, { thinking: thinkingContent });
          this.purgeEphemeralAtSpanEnd("self_check_limit");
          return;
        }

        selfCheckRounds++;
        flushAssistantText(true); // promise テキスト (継続する中間) = 灰色
        console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] ツール未呼び出し`));
        this.notice("info", `[自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] ツール未呼び出し`);
        // promise テキストと nudge は in-turn 専用、 thinking も保全
        this.history.addAssistantMessage(textContent, undefined, { ephemeral: true, thinking: thinkingContent });
        // 2026-05-01: C 案。 「promise テキストだけでは作業継続と認識しない」 を明示し、
        // 短い「了解しました」「実装します」 等の応答で止まるループを抜けやすくする。
        this.history.addUserMessage(
          formatSelfCheck(
            selfCheckRounds, MAX_SELF_CHECK_ROUNDS, userMessageText,
            `テキスト応答のみでツール呼出がありません。 ` +
            `「了解しました」「実装します」 等の promise テキストだけではハーネスは作業継続と認識しません。 ` +
            `思考 → ToDo → 実行 のリズムで進めてください: ` +
            `(a) 戦略がまだ決まっていない → \`todo_append\` で計画を 3-5 項目立てる、 ` +
            `(b) 既存 ToDo があるなら該当項目を \`todo_mark(id, "in_progress")\` してから実装 tool (file_write / file_edit / bash / mcp__...) を呼ぶ、 ` +
            `(c) 行き詰まりなら \`todo_mark(id, "blocked")\` + \`ask_user\` で相談。`
          ),
          { ephemeral: true },
        );
        continue;
      }

      // コードブロックをテキスト返した場合のリプロンプト（file_write未使用検出）
      if (toolCalls.length === 0 && !codeBlockRetried && hasLargeCodeBlock(textContent) &&
          selfCheckRounds < MAX_SELF_CHECK_ROUNDS) {
        codeBlockRetried = true;
        selfCheckRounds++;
        flushAssistantText(true); // 継続する中間テキスト = 灰色
        console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] コードがテキスト応答に含まれています`));
        this.notice("info", `[自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] コードがテキスト応答に含まれています`);
        // コードを含む中間応答と nudge は in-turn 専用、 thinking も保全
        this.history.addAssistantMessage(textContent, undefined, { ephemeral: true, thinking: thinkingContent });
        this.history.addUserMessage(
          formatSelfCheck(
            selfCheckRounds, MAX_SELF_CHECK_ROUNDS, userMessageText,
            `コードをテキストで返しましたが、実際のファイル作成には file_write ツールが必要です。` +
            `意図したパスにファイルを保存する場合は file_write を呼んでください。`
          ),
          { ephemeral: true },
        );
        continue;
      }

      // リプロンプト後もツールを呼ばず、JSONコードブロックでfile_writeを「説明」している場合
      // → JSONを解析して直接実行する
      if (toolCalls.length === 0 && codeBlockRetried) {
        const fakeWrites = extractFakeFileWriteCalls(textContent);
        if (fakeWrites.length > 0) {
          console.log(chalk.yellow(`\n  ツール呼び出しの代わりにJSONが返されました。${fakeWrites.length}件のfile_writeを直接実行します...`));
          this.history.addAssistantMessage(textContent, undefined, { thinking: thinkingContent });
          let shouldAbort = false;
          for (const fw of fakeWrites) {
            const syntheticCall: ToolCall = {
              id: `synthetic_fw_${Date.now()}`,
              type: "function",
              function: { name: "file_write", arguments: JSON.stringify(fw) },
            };
            shouldAbort = await this.executeSingleTool(syntheticCall);
            if (shouldAbort) {
              this.purgeEphemeralAtSpanEnd("synthetic_write_abort");
              return;
            }
          }
          // 書き込み完了後、モデルに続きを促す (in-turn の合図)
          this.history.addUserMessage("ファイルの作成が完了しました。", { ephemeral: true });
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
          // Phase 2: 思考保全 — thinking が出ていた場合は完全保全して placeholder にする。
          // モデルは次イテレーションで自分の前思考を読めるので、 同じ digestion を再生成
          // する無駄を避けられる。 ephemeral なので応答完了時に purge され次 span に漏れない。
          //
          // 機械的な文字カット (slice) は中途半端な切り取りで意味を壊しノイズになるため避ける。
          // ctx 圧迫の懸念は以下で十分に抑えられている:
          //   - MAX_EMPTY_RETRIES=3 で span 内の積み増し回数が上限固定
          //   - ContextManager (capability.compressionThreshold) が閾値到達で要約圧縮
          //   - 応答完了時の purgeEphemeral で span 境界を越えて残らない
          // docs/ephemeral-context-design.md §7.1 参照。
          const placeholder = thinkingContent.trim().length > 0
            ? `[前回の思考 ${thinkingContent.length}字 — 形式不一致で吐き出せず、 ハーネスが保全]\n${thinkingContent}`
            : "（空のレスポンス）";
          // empty-response placeholder と nudge は in-turn 専用 (応答完了時に purge)。
          // ユーザーへの最終応答が出れば、 これらの中間ノイズは過去 span から除去される。
          this.history.addAssistantMessage(placeholder, undefined, { ephemeral: true });
          // 2026-05-15: 空応答 retry の意味反転 (docs/strategic-todo-design.md §3.3)。
          // 旧 nudge は「ツール呼べ」 という圧力で、 弱モデルが戦略を立てる前に反応的に動く原因だった。
          // 新 nudge: 思考の deliberation を todo_append で commit させ、 戦略 → 実行 のリズムへ誘導する。
          // 「思考 → ToDo 化 → Action」 = ジャンプ前のしゃがみ込み。
          // 2026-06-07: 形状中立化 (docs/reactive-intervention-coherence-design.md §4.2)。
          // 旧 nudge は「思考を ToDo に commit せよ」 と機構を指示し、 答えが思考にあるのに
          // todo を作る矛盾を生んでいた (explore タスクと衝突)。 新 nudge は目的を再提示し、
          // 「答えがあるなら出力、 作業が要るなら実行」 と形をモデルの register 判断に委ねる。
          const hasThinking = thinkingContent.length > 0;
          this.history.addUserMessage(
            `[ハーネス通知] thinking は記録されましたが、 ユーザーに見える結果 (テキスト回答 / ツール呼出) がまだありません。\n\n` +
            `# 次の手 — 依頼にふさわしい形で可視的な結果を出す\n` +
            (hasThinking
              ? `- 思考の中で結論や答えが出ているなら → **それを回答テキストとして出力**する (答えだけで済む依頼はそれで完了。 必要なら response_complete)\n`
              : `- まず依頼への答え・方針をテキストで示す\n`) +
            `- まだ作業 (ファイル作成・検証等) が要るなら → \`todo_append\` で計画を立てる、 もしくは実装ツール (file_write / file_edit / bash / mcp__... 等) を呼ぶ\n` +
            `- 行き詰まりなら → \`ask_user\` で相談する\n\n` +
            (hasThinking
              ? `前回の思考は保全済み。 再思考は不要 — 結論をそのまま出力してください。\n\n`
              : "") +
            `# 元依頼\n${nudgeIntent}\n\n` +
            `中身の無い promise テキスト (「了解しました」「実装します」 等) *だけ* は進捗と認識しません (中身のある回答や実行は進捗です)。`,
            { ephemeral: true },
          );
          continue;
        }

        // 2026-06-07: honest failure (docs/reactive-intervention-coherence-design.md §4.3)。
        // 捏造しない (思考を scrape して疑似回答にしない) / 隠蔽しない (無言終了しない) /
        // 新規 LLM 呼び出しもしない (壊れた状態での追加呼出は無意味)。 何回試みて何が
        // 起きたかを正直に・具体的に報告して止める。 思考は llmLogger に保全済み。
        const hasThinking = thinkingContent.length > 0 || textContent.includes("<think>");
        const reason = hasThinking
          ? `モデルは ${thinkingContent.length}字 考えましたが、 ${emptyResponseRetries} 回試みても ユーザー向けの出力 (テキスト/ツール) を生成できませんでした`
          : `モデルから ${emptyResponseRetries} 回連続で空の応答が返りました`;
        console.log(chalk.yellow(
          `\n  ⚠ 結果を出力できませんでした: ${reason}。\n` +
          `    考えられる原因: コンテキスト長の超過 / 出力フォーマットの乱れ。\n` +
          `    対処: もう一度依頼する / 入力を短くする / 別のモデルに切り替える。` +
          (hasThinking ? `\n    （モデルの思考内容は LLM ログに保全されています）` : ""),
        ));
        this.notice("error", `結果を出力できませんでした: ${reason}`);
        // 偽の回答は履歴に入れない (捏造しない)。 honest failure は上記でユーザーに提示済み。
        this.purgeEphemeralAtSpanEnd("empty_response_giveup");
        return;
      }
      // ToDo 未完了ゲート (final_text_response 経路)。
      // docs/spinner-mode-response-coloring-design.md / docs/strategic-todo-design.md
      // response_complete は response-complete.ts で未完了 todo をブロックするが、
      // response_complete を呼ばずテキストだけで終わるこの経路にはゲートが無かった。
      // hasExecutedTools=true (このターンで実装/検証ツールを実行済み = タスク作業中) かつ
      // 未完了 todo がある場合、 自己点検 nudge を注入して「完了 or response_complete(force)」 を促す。
      // 上限到達時は未完了を明示してそのまま終了 (無限ループ防止)。
      if (
        hasExecutedTools &&
        selfCheckRounds < MAX_SELF_CHECK_ROUNDS &&
        !this.planManager?.isInPlanMode()
      ) {
        const allTodos = getTodosCurrent();
        const openTodos = allTodos.filter((t) => t.status !== "completed");
        if (allTodos.length > 0 && openTodos.length > 0) {
          selfCheckRounds++;
          flushAssistantText(true); // まだ完了していない中間テキスト = 灰色
          console.log(chalk.dim(
            `  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] ToDo未完了 (${openTodos.length}/${allTodos.length})`,
          ));
          this.notice("info", `[自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] ToDo未完了 (${openTodos.length}/${allTodos.length})`);
          this.history.addAssistantMessage(textContent, undefined, { ephemeral: true, thinking: thinkingContent });
          this.history.addUserMessage(
            formatSelfCheck(
              selfCheckRounds, MAX_SELF_CHECK_ROUNDS, userMessageText,
              `Acceptance Checklist (todo) に未完了が ${openTodos.length} 項目あります:\n${formatTodos()}\n` +
              `テキストだけで終わらせず、 次のいずれかを実行してください: ` +
              `(1) 残項目を実装/検証して該当 todo を completed にする、 ` +
              `(2) 部分完了で報告するなら \`response_complete(force=true)\` を呼び summary に未完了の理由を明記、 ` +
              `(3) 行き詰まりなら該当 todo を \`todo_mark(id, "blocked")\` してから \`ask_user\` で相談。`,
            ),
            { ephemeral: true },
          );
          continue;
        }
      }

      // 上限到達などでゲートを通過したが未完了 todo が残る場合: ユーザーに明示してから終了。
      if (hasExecutedTools) {
        const openAtEnd = getTodosCurrent().filter((t) => t.status !== "completed");
        if (openAtEnd.length > 0) {
          console.log(chalk.yellow(
            `\n  ⚠ ToDo が ${openAtEnd.length} 項目未完了のまま応答を返します (自己点検上限到達)。`,
          ));
        }
      }

      // ここに到達 = ツールも自己点検も無く turn が終わる = ユーザーへの最終応答 → 白/Markdown。
      flushAssistantText(false);
      this.history.addAssistantMessage(textContent, undefined, { thinking: thinkingContent });
      this.purgeEphemeralAtSpanEnd("final_text_response");
      return;
    }

    console.log(chalk.yellow("\n  Maximum tool iterations reached."));
    this.events.emit("harness_notice", { level: "warn", message: "反復上限に到達しました" });
    this.purgeEphemeralAtSpanEnd("max_iterations");
    } finally {
      this.isProcessing = false;
      // task_complete は finally で必ず発火する (例外・全 return 経路を含む)。
      // outcome は purgeEphemeralAtSpanEnd() の reason マッピングで設定済み。
      // 未設定 (incomplete) のまま中断フラグが立っていれば aborted に倒す。
      if (this.runStats.outcome === "incomplete" && this._aborted) {
        this.runStats.outcome = "aborted";
      }
      this.events.emit("task_complete", {
        source: this.currentSource,
        outcome: this.runStats.outcome,
        finalResponse: this.runStats.finalText,
        iterations: this.runStats.iterations,
        durationMs: Date.now() - this.runStats.startMs,
        toolsExecuted: this.runStats.toolsExecuted,
      });
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
      toolName === "second_llm_agent" &&
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
    this.notice("warn", "対話必須ロック発動 (file_write/file_edit を拒否、 ask_user で解除)");
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

  /**
   * span 境界 (= ユーザー応答完了 / abort / 上限到達) で in-turn 専用のメッセージを破棄する。
   * 詳細は docs/ephemeral-context-design.md を参照。
   *
   * 思想: ハーネスの自己点検・nudge・空応答 placeholder・stuck-loop 介入は span 内では
   * モデルに必要だが、 ユーザー応答が出た後は「消費し終えた scratch space」 として捨てる。
   * これにより過去 span の harness ノイズが次 span の判断を引きずらない。
   *
   * @param reason ログ用の理由タグ (response_complete / user_abort / etc.)
   */
  private purgeEphemeralAtSpanEnd(reason: string): void {
    // span 終了点はほぼすべてここを通るため、 task_complete イベント用の outcome を
    // reason から決定する (docs/agent-events-design.md §3.1)。 発火自体は run() の finally。
    this.runStats.outcome = AgentLoop.SPAN_END_OUTCOMES[reason] ?? "incomplete";
    const purged = this.history.purgeEphemeral();
    if (purged > 0) {
      console.log(chalk.dim(`  [ephemeral-purge] ${purged} 件の in-turn 補助メッセージを破棄 (${reason})`));
    }
    // 思考保全 (Phase 2 本実装): span 境界で残存する thinking も削除する。
    // 「span 内では活用、 ユーザー応答後に破棄」 の原則を実装に反映 (commit c5147fd の意図)。
    const clearedThinking = this.history.clearAllThinking();
    if (clearedThinking > 0) {
      console.log(chalk.dim(`  [thinking-purge] ${clearedThinking} 件の thinking を破棄 (${reason})`));
    }
  }

  /**
   * span 終了 reason → task_complete の outcome。 docs/agent-events-design.md §3.1
   * self_check_limit は「点検上限に達したが応答は返した」 のでユーザー視点では completed。
   */
  private static readonly SPAN_END_OUTCOMES: Record<string, TaskOutcome> = {
    response_complete: "completed",
    final_text_response: "completed",
    self_check_limit: "completed",
    user_abort: "aborted",
    llm_error_abort: "aborted",
    tool_abort: "aborted",
    synthetic_write_abort: "aborted",
    garbage_response: "error",
    empty_response_giveup: "error",
    llm_call_unsuccessful: "error",
    max_iterations: "max_iterations",
  };

  /**
   * P0-A: ツール失敗を sliding window で追跡し、 同じ (signature, error) が
   * 直近 FAILURE_WINDOW 反復内に再発したら self-check メッセージを history へ注入する。
   *
   * 既存の MAX_REPEAT_TOOL=3 (連続検出) は grep/read を間に挟まれると無効化されるため、
   * これは「間に他ツールが挟まっても失敗の繰り返しを検出する」 補強。
   * docs/agent-loop-efficiency-review.md §4.2 参照。
   */
  private static readonly FAILURE_WINDOW = 10;
  private maybeDetectStuckLoop(toolCall: ToolCall, errorMsg: string): void {
    const iteration = this.currentIteration;
    const signature = `${toolCall.function.name}:${toolCall.function.arguments ?? ""}`;
    // window 外の古いエントリを除去
    this.recentFailures = this.recentFailures.filter(
      (e) => iteration - e.iteration < AgentLoop.FAILURE_WINDOW,
    );
    const trimmedErr = (errorMsg ?? "").slice(0, 500);
    const prior = this.recentFailures.filter(
      (e) => e.signature === signature && e.error === trimmedErr,
    );
    this.recentFailures.push({ iteration, signature, error: trimmedErr });
    if (prior.length === 0) return; // 初回失敗 → 通常通り

    // 直近 window 内に同じ失敗が既にあった → 学習されていない兆候
    // Phase D-2: T3 では decision-tree mode で binary 二択を提示する。
    // 自由形式の助言は T3 にとって判断負荷が高く、 さらに迷走する原因になるため。
    const intervention = this.capability.tier === "T3"
      ? this.buildT3DecisionTreeIntervention(toolCall, trimmedErr, prior.length + 1)
      : this.buildStandardStuckLoopIntervention(toolCall, trimmedErr, prior.length + 1);
    console.log(chalk.yellow(`\n  ⚠ stuck-loop 検出: ${toolCall.function.name} が直近${AgentLoop.FAILURE_WINDOW}反復で同一エラー再発 (tier=${this.capability.tier})`));
    this.notice("warn", `stuck-loop 検出: ${toolCall.function.name} の同一エラー再発`);
    // stuck-loop 介入は in-turn の方向修正なので応答完了時に purge
    this.history.addUserMessage(intervention, { ephemeral: true });
    // 注入後は当該 signature の履歴をクリアして再注入を防ぐ
    this.recentFailures = this.recentFailures.filter((e) => e.signature !== signature);
  }

  /** Phase D-2: T1/T2 向け標準介入 (自由形式の advice) */
  private buildStandardStuckLoopIntervention(toolCall: ToolCall, errorMsg: string, occurrences: number): string {
    const advice = this.buildStuckLoopAdvice(toolCall.function.name, errorMsg);
    return (
      `[ハーネス] 直近${AgentLoop.FAILURE_WINDOW}反復内に「${toolCall.function.name}」 を同じ引数で実行し、 同じエラーが ${occurrences} 回出ています。\n` +
      `  エラー: ${errorMsg.slice(0, 200)}\n` +
      `  ${advice}\n` +
      `  同じ引数での再試行は禁止。 別の引数 / 別ツール / ask_user のいずれかに切り替えてください。`
    );
  }

  /**
   * Phase D-2: T3 向け decision-tree 介入。
   *
   * 自由形式で「別アプローチを取れ」 と言っても T3 は判断できないことが多い。
   * 代わりに binary 二択を提示し、 「どちらかを 1 行で答えてから tool 実行」 と強制する。
   * docs/multi-tier-harness-roadmap.md §4 D-2 参照。
   */
  private buildT3DecisionTreeIntervention(toolCall: ToolCall, errorMsg: string, occurrences: number): string {
    const name = toolCall.function.name;
    const [optionA, optionB] = this.buildBinaryDecisionOptions(name, errorMsg, toolCall.function.arguments ?? "");
    return (
      `[ハーネス] 「${name}」 を同じ引数で ${occurrences} 回失敗。 同じエラー: ${errorMsg.slice(0, 150)}\n` +
      `\n` +
      `次にどちらかを実行してください (両方やらない):\n` +
      `  A) ${optionA}\n` +
      `  B) ${optionB}\n` +
      `\n` +
      `1 行目に "A" か "B" を書いて、 同じターンで対応する tool 呼び出しをしてください。 これ以外の選択は禁止です。`
    );
  }

  /**
   * Phase D-2: ツール × エラー種別ごとの binary 選択肢を返す。
   * A は「具体的な引数変更」、 B は基本「ask_user で人間に確認」 で固定。
   * 二択の単純化が T3 の迷走を防ぐ。
   */
  private buildBinaryDecisionOptions(
    toolName: string,
    errorMsg: string,
    _argumentsJson: string,
  ): [string, string] {
    if (toolName === "file_edit") {
      if (errorMsg.includes("found") && errorMsg.includes("times")) {
        return [
          "同じ file_edit に replace_all=true を追加して再実行",
          "ask_user で「どの箇所を編集するか」 を確認",
        ];
      }
      if (errorMsg.includes("not found")) {
        return [
          "file_write でファイル全体を書き直す",
          "ask_user で「ファイルパスが正しいか」 を確認",
        ];
      }
    }
    if (toolName === "file_read" && errorMsg.includes("not found")) {
      return [
        "glob でファイル名を検索 (例: glob({\"pattern\":\"**/<name>\"}))",
        "ask_user で「正しいファイルパス」 を確認",
      ];
    }
    if (toolName === "bash") {
      return [
        "コマンドの引数を変えて再実行 (例: 別コマンドや別 path)",
        "ask_user で「期待する動作」 を確認",
      ];
    }
    if (toolName === "grep" || toolName === "glob") {
      return [
        "pattern を緩める (例: より一般的な単語、 拡張子なし)",
        "ask_user で「探したい内容」 を確認",
      ];
    }
    // 汎用 fallback
    return [
      "ツールの引数を 1 つ変更して再実行 (エラー文の指示に従う)",
      "ask_user で「どう進めるか」 を確認",
    ];
  }

  /** P0-A: 失敗ツールごとの具体的助言を返す。 ツール側エラー文の指示を増幅させる役割。 */
  private buildStuckLoopAdvice(toolName: string, errorMsg: string): string {
    if (toolName === "file_edit") {
      if (errorMsg.includes("found") && errorMsg.includes("times")) {
        return "対処: replace_all=true を指定するか、 old_string の前後を含めて一意化してください。";
      }
      if (errorMsg.includes("not found")) {
        return "対処: file_read でファイル現状を確認 → 一意な部分文字列で再構築。 諦めて file_write も検討。";
      }
    }
    if (toolName === "bash") {
      return "対処: コマンドのエラー出力を読み、 引数や前提を変更してから再試行してください。 同じコマンドの単純再試行は無効。";
    }
    if (toolName === "file_read") {
      return "対処: パスを再確認 (絶対パスか / 親ディレクトリは存在するか)。 同じパスの再試行は無効。";
    }
    return "対処: エラーメッセージの示す通りに引数を変えるか、 別ツールに切り替えてください。";
  }

  /**
   * P3-A: レジスター別ソフトキャップ。 hard cap (MAX_TOOL_ITERATIONS=100) 内に収まる
   * 範囲で、 軽量タスクは早めに警告。 docs/agent-loop-efficiency-review.md §4.1 参照。
   */
  private static readonly REGISTER_SOFT_CAP: Record<string, number> = {
    explore: 20,
    rough: 30,
    standard: 70,
    production: 100, // hard cap と同値
    unknown: 100, // レジスター宣言なし → 従来動作と同じ
  };
  /**
   * 「standard 以上」 のレジスター判定。 base harness の persistence gate
   * (Q→A 進捗 / コヒーレンス) の発火条件。 docs/strategic-todo-design.md §2.2 議論。
   */
  private isStandardOrAboveRegister(): boolean {
    const reg: string = this.currentRegister;
    return reg === "standard" || reg === "production";
  }

  private computeRegisterSoftCap(): number {
    return AgentLoop.REGISTER_SOFT_CAP[this.currentRegister] ?? MAX_TOOL_ITERATIONS;
  }

  /**
   * P3-A: アシスタントの応答テキストから「このタスクは X として進めます」 系の
   * 宣言を検出してレジスターを更新。 system-prompt 規約 (system-prompt.ts:73-) に対応。
   * 一度設定したら user 発話で reset されるまで維持。
   */
  private detectRegisterFromText(text: string): void {
    if (this.currentRegister !== "unknown") return; // 既に決まっていれば変えない
    if (!text) return;
    // 「このタスクは X として」 / 「完了レベル: X」 / 「register: X」 / 英語表現も拾う
    const patterns: Array<[RegExp, AgentLoop["currentRegister"]]> = [
      [/(?:このタスクは|task is|完了レベル[:：]?|register[:：])\s*(production|本番品質|本番)/i, "production"],
      [/(?:このタスクは|task is|完了レベル[:：]?|register[:：])\s*(standard|通常)/i, "standard"],
      [/(?:このタスクは|task is|完了レベル[:：]?|register[:：])\s*(rough|ラフ|MVP)/i, "rough"],
      [/(?:このタスクは|task is|完了レベル[:：]?|register[:：])\s*(explore|探索|短答)/i, "explore"],
    ];
    for (const [re, reg] of patterns) {
      if (re.test(text)) {
        this.currentRegister = reg;
        console.log(chalk.dim(`  [register] "${reg}" に設定 (soft cap = ${this.computeRegisterSoftCap()})`));
        return;
      }
    }
  }

  /**
   * P1-A: bash 累積時間 / P1-B: plan/todo 呼出回数を観測し、 閾値超過で 1 度だけ
   * self-check を注入する。 ツール完了直後に呼び出される。
   * docs/agent-loop-efficiency-review.md §4.4 / §4.6 参照。
   */
  private static readonly BASH_CUMULATIVE_WARN_MS = 5 * 60 * 1000; // 5 分
  private static readonly PLAN_MODE_LIMIT = 2;
  private static readonly TODO_WRITE_LIMIT = 5;
  private maybeWarnBashCumulative(toolCall: ToolCall, durationMs: number): void {
    if (toolCall.function.name !== "bash") return;
    // Phase C-3: tier で feature gating。 T3 では判断負荷増になるため抑制。
    if (!this.capability.bashCumulativeWarnEnabled) return;
    this.bashCumulativeMs += durationMs;
    if (this.bashCumulativeWarned) return;
    if (this.bashCumulativeMs < AgentLoop.BASH_CUMULATIVE_WARN_MS) return;
    const totalSec = Math.round(this.bashCumulativeMs / 1000);
    console.log(chalk.yellow(`\n  ⚠ bash 累積実行時間が ${totalSec}s に達しました。 重い build/run の連発を見直してください`));
    this.history.addUserMessage(
      `[ハーネス] このユーザー発話以降、 bash の累積実行時間が ${totalSec}s を超えました。\n` +
      `  重い検証 (build / 起動 / 全件再実行) を毎 edit ごとに走らせていませんか?\n` +
      `  対策: (a) 複数 edit をまとめてから 1 回 build (b) syntax check (\`node --check\` / \`tsc --noEmit\` 等) で軽く確認 (c) ホットリロードを活用 (d) 同一コマンドの単純再実行は禁止。`,
      { ephemeral: true },
    );
    this.bashCumulativeWarned = true;
  }
  private maybeWarnPlanTodoOveruse(toolCall: ToolCall): void {
    // Phase C-3: tier で feature gating。 T1/T3 では plan/todo 過多検知を抑制。
    // T1: 賢いLLMは自然に最小限で運用 / T3: scaffolding 増加が判断負荷を上げる
    if (!this.capability.planTodoOveruseEnabled) return;
    const name = toolCall.function.name;
    if (name === "enter_plan_mode") this.planModeEntries++;
    if (name === "todo_write") this.todoWriteCount++;
    if (this.planTodoWarned) return;
    const planOver = this.planModeEntries > AgentLoop.PLAN_MODE_LIMIT;
    const todoOver = this.todoWriteCount > AgentLoop.TODO_WRITE_LIMIT;
    if (!planOver && !todoOver) return;
    const reasons: string[] = [];
    if (planOver) {
      reasons.push(
        `enter_plan_mode を ${this.planModeEntries} 回呼んでいます (上限 ${AgentLoop.PLAN_MODE_LIMIT})。 「計画蒸発」 (計画を立てて抜け、 また立てる) の兆候です。`,
      );
    }
    if (todoOver) {
      reasons.push(
        `todo_write を ${this.todoWriteCount} 回呼んでいます (上限 ${AgentLoop.TODO_WRITE_LIMIT})。 細切れの todo 更新で反復が嵩みます。`,
      );
    }
    console.log(chalk.yellow(`\n  ⚠ 計画/Todo 過多検知: ${reasons.join(" / ")}`));
    this.history.addUserMessage(
      `[ハーネス] このユーザー発話以降、 計画/Todo の更新が過多です:\n` +
      reasons.map((r) => `  - ${r}`).join("\n") +
      `\n  対策: 既存の todo を見直し、 必要なら 1 回だけ更新する。 計画モード再突入は禁止 — 既存計画を流用して実装を進めてください。`,
      { ephemeral: true },
    );
    this.planTodoWarned = true;
  }

  /** Execute a single tool call, returning whether to abort the rest of the run loop */
  private async executeSingleTool(toolCall: ToolCall): Promise<boolean> {
    const summary = formatToolCall(toolCall);
    this.events.emit("tool_start", { callId: toolCall.id, name: toolCall.function.name, summary });
    const spinner = ora(chalk.dim(`  ${summary}...`)).start();
    // 権限確認ダイアログがスピナーに隠れないよう、
    // 確認が必要なツールではスピナーを一時停止してから execute する。
    // execute 内部で permission check → inquirer prompt が走るため、
    // スピナーが stdout を専有していると入力が見えなくなる。
    // ask_user / exit_plan_mode は INHERENTLY_SAFE で permission ask されないが
    // ツール内部で inquirer prompt を出すため同じく停止が必要。
    const toolName = toolCall.function.name;
    const isInteractiveTool = toolName === "ask_user" || toolName === "exit_plan_mode";
    // 入れ子で独自スピナーを出すツール (second-llm-manager 等)。 外側スピナーと
    // 二重アニメーションになり同じ行で点滅するため、 外側は静的行として残す。
    const isNestedSpinnerTool = toolName === "second_llm_agent";
    const needsApproval = this.permissions.getPermissionLevel(toolName) === "ask"
      && this.currentSource === "cli";
    let outerSpinnerPersisted = false;
    if (needsApproval || (isInteractiveTool && this.currentSource === "cli")) {
      spinner.stop();
    } else if (isNestedSpinnerTool && this.currentSource === "cli") {
      // 依頼内容 (summary) は静的行として出しっぱなしにし、 進捗アニメは入れ子スピナーに一本化。
      spinner.stopAndPersist({ symbol: chalk.dim("↳"), text: chalk.dim(`  ${summary}`) });
      outerSpinnerPersisted = true;
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
    this.runStats.toolsExecuted++;
    this.events.emit("tool_end", {
      callId: toolCall.id,
      name: toolName,
      summary,
      success: result.success,
      durationMs: toolDurationMs,
      error: result.success ? undefined : result.error,
    });

    // Phase 5 第10ラウンド: 対話必須ロックの発動契機を判定
    this.maybeTriggerDialogueLock(toolName, result);

    if (result.success) {
      // outerSpinnerPersisted の場合は既に summary を静的表示済 → 二重表示しない
      if (!outerSpinnerPersisted) spinner.succeed(chalk.dim(`  ${summary}`));
      // ファイル変更時はカラーdiffを表示
      if (result.userDisplay) {
        this.renderUserDisplay(result.userDisplay);
      }
    } else if (outerSpinnerPersisted) {
      console.log(chalk.dim(`  ${summary}: ${formatToolError(result.error, result.output)}`));
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
    // Phase B-3: 能力ティアを渡して、 T3 では few-shot 例も追加注入する。
    const guide = getFirstUseGuide(toolCall.function.name, this.capability.tier);
    if (guide) {
      resultContent += "\n\n" + guide;
    }

    // Phase 5 第2ラウンド: ハーネス介入レイヤ (共通モジュール)。
    // file_edit 連続失敗 / 壁ドンループ / Read→Edit 契約 / 連続委任ガード / 旧エラーガイダンス
    // を一括で適用。
    resultContent = enrichToolResult(toolCall, result.success, resultContent, this.harnessState);

    // Phase D-3: T3 でツール失敗時、 該当エラーパターン用の failure few-shot を 1 度だけ末尾に注入。
    // (toolName, errorPattern) ごとに 1 度のみ → 重複 spam 抑制。 D-2 (stuck-loop) より早く発動する。
    if (!result.success) {
      const failGuide = getFailureGuide(
        toolCall.function.name,
        (result.error ?? result.output ?? "").toString(),
        this.capability.tier,
      );
      if (failGuide) resultContent += "\n\n" + failGuide;
    }

    // P2-B + Phase C-3: 巨大 tool_result はコンテキスト膨張の主因。 履歴格納時に頭尾を残して
    // 中央を要約。 閾値は tier 別 (T1=20KB / T2=12KB / T3=6KB)。
    resultContent = truncateLargeToolResult(
      toolCall.function.name,
      resultContent,
      this.capability.toolResultTruncateBytes,
    );

    this.history.addToolResult(toolCall.id, resultContent);

    // P0-A: 失敗時に sliding-window で「同じ轍」 を検出して self-check 注入
    if (!result.success) {
      const errMsg = (result.error ?? result.output ?? "").toString();
      this.maybeDetectStuckLoop(toolCall, errMsg);
    }
    // P1-A/B: bash 累積時間と plan/todo 過多を観測
    this.maybeWarnBashCumulative(toolCall, toolDurationMs);
    this.maybeWarnPlanTodoOveruse(toolCall);

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
        this.events.emit("tool_start", { callId: toolCall.id, name: toolCall.function.name, summary });
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
        this.runStats.toolsExecuted++;
        this.events.emit("tool_end", {
          callId: toolCall.id,
          name: toolCall.function.name,
          summary,
          success: result.success,
          durationMs,
          error: result.success ? undefined : result.error,
        });
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
        // Phase B-3: 並列ルートでも能力ティアを渡す
        const guide = getFirstUseGuide(toolCall.function.name, this.capability.tier);
        if (guide) {
          resultContent += "\n\n" + guide;
        }

        // Phase 5 第2ラウンド: ハーネス介入レイヤ (並列ルートでも適用)
        resultContent = enrichToolResult(toolCall, result.success, resultContent, this.harnessState);

        // Phase D-3: 並列ルートでも T3 失敗時の failure few-shot を注入
        if (!result.success) {
          const failGuide = getFailureGuide(
            toolCall.function.name,
            (result.error ?? result.output ?? "").toString(),
            this.capability.tier,
          );
          if (failGuide) resultContent += "\n\n" + failGuide;
        }

        // P2-B + Phase C-3: 巨大 tool_result の頭尾要約 (並列ルートも同様に適用)
        resultContent = truncateLargeToolResult(
          toolCall.function.name,
          resultContent,
          this.capability.toolResultTruncateBytes,
        );

        this.history.addToolResult(toolCall.id, resultContent);

        // P0-A: 並列ルートでも同じ sliding-window 失敗検出を適用
        if (!result.success) {
          const errMsg = (result.error ?? result.output ?? "").toString();
          this.maybeDetectStuckLoop(toolCall, errMsg);
        }
        // P1-A/B: 並列ルートでも bash 累積時間 / plan/todo 過多を観測
        this.maybeWarnBashCumulative(toolCall, durationMs);
        this.maybeWarnPlanTodoOveruse(toolCall);

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
    // docs/todo-goal-lifecycle.md §2.3 — in-memory slot を session JSON に保存
    this.session.todos = getTodosCurrent();
    const goal = getGoalSlot();
    this.session.goal = goal ? { definition: goal, history: getEvaluationHistory() } : null;
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
    // 再ビルド用パラメータも更新 (圧縮 OFF 復帰や再圧縮で最新の skills/flags を使うため)
    if (skills !== undefined) this.builtSkills = skills;
    if (hasSecondLLM !== undefined) this.builtHasSecondLLM = hasSecondLLM;
    if (hasObsidian !== undefined) this.builtHasObsidian = hasObsidian;
    // Phase B-2: tier 反映。 base のみ更新、 動的部分は composer が次回 getMessages() で合成。
    // 入力圧縮 ON 中はキャッシュ済みの圧縮済みテキストを overrides として渡し、 圧縮が裏で
    // 解除される silent な不整合を防ぐ (project/メモは不変なので LLM 再呼出は不要)。
    const systemPrompt = buildSystemPrompt(
      skills, hasSecondLLM, hasObsidian, profiles, this.capability.tier, this.currentCompressionOverrides(),
    );
    this.history.updateSystemPrompt(systemPrompt);
  }

  /** tier 別の圧縮発動閾値 (文字数)。 旧 truncate 値を踏襲。 docs/input-compression-design.md */
  private inputCompressionLimits(): { project: number; memory: number } {
    const t = this.capability.tier;
    return {
      project: t === "T3" ? 1500 : t === "T1" ? 4000 : 3000,
      memory: t === "T3" ? 1000 : t === "T1" ? 3000 : 2000,
    };
  }

  getInputCompressionEnabled(): boolean {
    return this.inputCompressionEnabled;
  }

  /** /context 可視化用: 直近の圧縮結果 (原文込み)。 */
  getCompressionState(): ReadonlyArray<{
    label: string;
    original: string;
    beforeTokens: number;
    afterTokens: number;
    applied: boolean;
    note?: string;
  }> {
    return this.compressionState;
  }

  /**
   * opt-in 入力圧縮の適用/解除。 docs/input-compression-design.md
   *
   * enabled=true: project指示/メモが tier別閾値を超えていれば、 履歴を含まないクリーンな
   *   単発呼び出しで意図保持圧縮し、 圧縮済みテキストで system prompt を再ビルドする。
   *   サイズガードで縮まなければ原文を使う。 原文は compressionState に常に保持。
   * enabled=false: 圧縮を解除し、 full な system prompt に戻す。
   *
   * 圧縮は LLM 呼び出しを伴うため非同期。 起動時/モデル切替時/トグル時に一度だけ呼ぶ
   * (毎ターンは呼ばない — project/メモは不変)。
   */
  async applyInputCompression(enabled: boolean): Promise<void> {
    this.inputCompressionEnabled = enabled;
    this.compressionState = [];

    if (!enabled) {
      // 実行時に OFF へ切替えた場合は full に戻す
      const full = buildSystemPrompt(
        this.builtSkills, this.builtHasSecondLLM, this.builtHasObsidian, this.llmProfiles, this.capability.tier,
      );
      this.history.updateSystemPrompt(full);
      return;
    }

    const limits = this.inputCompressionLimits();
    const rawProject = loadProjectInstructions();
    const rawMemory = loadMemory();
    const overrides: SystemPromptOverrides = {};

    if (rawProject && rawProject.length > limits.project) {
      const r = await compressText(this.provider, this.model, "プロジェクト指示", rawProject);
      if (r.applied) overrides.projectInstructions = r.text;
      this.compressionState.push({ label: "プロジェクト指示", original: r.original, compressedText: r.applied ? r.text : undefined, beforeTokens: r.beforeTokens, afterTokens: r.afterTokens, applied: r.applied, note: r.note });
    }
    if (rawMemory && rawMemory.length > limits.memory) {
      const r = await compressText(this.provider, this.model, "メモ", rawMemory);
      if (r.applied) overrides.memory = r.text;
      this.compressionState.push({ label: "メモ", original: r.original, compressedText: r.applied ? r.text : undefined, beforeTokens: r.beforeTokens, afterTokens: r.afterTokens, applied: r.applied, note: r.note });
    }

    if (overrides.projectInstructions !== undefined || overrides.memory !== undefined) {
      const compressed = buildSystemPrompt(
        this.builtSkills, this.builtHasSecondLLM, this.builtHasObsidian, this.llmProfiles, this.capability.tier, overrides,
      );
      this.history.updateSystemPrompt(compressed);
    }
  }

  /**
   * 現在キャッシュされている圧縮結果から system prompt overrides を復元する
   * (LLM 再呼出なし)。 圧縮 ON 中に system prompt を再ビルドする経路
   * (updateLLMProfiles / restoreSession) が、 圧縮状態を取りこぼして全量に
   * 戻ってしまう silent な不整合を防ぐ。
   */
  private currentCompressionOverrides(): SystemPromptOverrides {
    const ov: SystemPromptOverrides = {};
    if (!this.inputCompressionEnabled) return ov;
    for (const s of this.compressionState) {
      if (!s.applied || s.compressedText === undefined) continue;
      if (s.label === "プロジェクト指示") ov.projectInstructions = s.compressedText;
      else if (s.label === "メモ") ov.memory = s.compressedText;
    }
    return ov;
  }

  restoreSession(sessionData: SessionData): void {
    this.session = sessionData;
    // resume したセッションの安定 ID にチェックポイント名前空間を載せ替える (H1)。
    // これでプロセスを跨いで前回のチェックポイントを list/restore できる。
    this.checkpointManager.rebind(sessionData.meta.id);
    // docs/todo-goal-lifecycle.md §2.2 — session 境界の責任主体。
    // 別 session を載せ替える前に in-memory slot を一斉リセット
    // (同プロセス内 /resume での cross-contamination 阻止)。
    this.exitGoalSeek("abort");
    clearTodos();
    // Phase B-2: tier 反映。 入力圧縮 ON 中はキャッシュ済み圧縮テキストを引き継ぐ
    // (project/メモは作業フォルダ単位で session を跨いでも不変)。
    const systemPrompt = buildSystemPrompt(
      this.builtSkills, this.builtHasSecondLLM, this.builtHasObsidian, this.llmProfiles, this.capability.tier,
      this.currentCompressionOverrides(),
    );
    this.history = new MessageHistory(systemPrompt);
    // 戦略 ToDo Phase 1: 新しい MessageHistory にも composer を注入
    this.history.setSystemPromptComposer((base) => this.composeQuasiSystemPrompt(base));
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
    // docs/todo-goal-lifecycle.md §2.3 — in-memory slot 復元 (旧 session は optional のためスキップ)
    if (sessionData.todos && sessionData.todos.length > 0) {
      setTodosFromGoal(sessionData.todos);
    }
    if (sessionData.goal) {
      restoreGoalState(sessionData.goal.definition, sessionData.goal.history);
      this.currentMode = "goal-seek";
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

  /**
   * Phase F-4: 現セッションのテレメトリスナップショット。
   * REPL の /metrics コマンドで現在進行中の状態を可視化するために使う。
   * docs/multi-tier-harness-roadmap.md §4 Phase F-4 参照。
   */
  getMetrics(): {
    iteration: number;
    bashCumulativeMs: number;
    bashWarned: boolean;
    planModeEntries: number;
    todoWriteCount: number;
    planTodoWarned: boolean;
    softCapWarned: boolean;
    recentFailures: number;
    register: string;
    softCap: number;
    hardCap: number;
    mode: AgentMode;
    goalStatement: string | null;
    acceptanceCriteriaCount: number;
  } {
    const goal = getGoalSlot();
    return {
      iteration: this.currentIteration,
      bashCumulativeMs: this.bashCumulativeMs,
      bashWarned: this.bashCumulativeWarned,
      planModeEntries: this.planModeEntries,
      todoWriteCount: this.todoWriteCount,
      planTodoWarned: this.planTodoWarned,
      softCapWarned: this.softCapWarned,
      recentFailures: this.recentFailures.length,
      register: this.currentRegister,
      softCap: this.computeRegisterSoftCap(),
      hardCap: this.capability.maxIterations,
      mode: this.currentMode,
      goalStatement: goal?.statement ?? null,
      acceptanceCriteriaCount: goal?.acceptance_criteria.length ?? 0,
    };
  }

  // ─── Goal Seek mode (docs/goal-seek-mode-design.md) ───

  getMode(): AgentMode {
    return this.currentMode;
  }

  /**
   * Goal Seek mode へ入る。 user 明示経由のみ呼ばれる (slash command `/goal-seek`)。
   * AI 側から呼ぶ経路を作らない (= 自動判定禁止、 設計書 §2.2)。
   *
   * @param goal user 入力をベースに AI が要約し user 承認した GoalDefinition
   * @param seedTodos true なら acceptance_criteria を todo に同期 (default true)。
   *                  todo gate (response-complete.ts) で acceptance 充足を強制するため。
   */
  enterGoalSeek(goal: GoalDefinition, seedTodos: boolean = true): void {
    setGoalSlot(goal);
    this.currentMode = "goal-seek";
    if (seedTodos) {
      setTodosFromGoal(
        goal.acceptance_criteria.map((c) => ({ content: c, status: "pending" as const })),
      );
    }
    // 準システムプロンプト composer (構築時に注入済) が次回 getMessages() で goal section を含めて再合成する。
    // ここで明示的な updateSystemPrompt は不要。
    logger.info(`[goal-seek] mode entered, ${goal.acceptance_criteria.length} criteria`);
  }

  /**
   * Goal Seek mode を抜ける。 user 明示 (/exit-goal-seek) または acceptance 全合格 +
   * response_complete でも自動的に呼ばれる。
   */
  exitGoalSeek(reason: "user" | "completed" | "abort" = "user"): void {
    if (this.currentMode === "forward") return;
    clearGoalSlot();
    this.currentMode = "forward";
    // composer が次回 getMessages() で goal section を含めない形で再合成する。
    logger.info(`[goal-seek] mode exited (${reason})`);
  }

  /**
   * 準システムプロンプトを毎呼出で fresh に合成する composer。
   * MessageHistory.getMessages() から呼ばれる (動的合成、 docs/strategic-todo-design.md §3.1)。
   *
   * 構成:
   *   1. base: 静的 system prompt (agent identity / tool guides 等)
   *   2. Goal section: goal-seek mode かつ Goal Slot がある時のみ
   *   3. ToDo section: todos が立っている時のみ (mode を問わず常時表示 = 戦略の可視化)
   *
   * 注: register / mode 表示 は今後追加候補 (Phase 1 試験的)。 現状は省略。
   */
  private composeQuasiSystemPrompt(base: string): string {
    const parts: string[] = [base];
    if (this.currentMode === "goal-seek") {
      const goalSection = buildGoalSlotSection();
      if (goalSection) parts.push(goalSection);
    }
    const todoSection = buildTodoSection();
    if (todoSection) parts.push(todoSection);
    return parts.join("\n\n");
  }

  setContextWindow(value: number): void {
    this.contextWindow = value;
    this.contextManager.setContextWindow(value);
    // Phase A-3: ctx 窓変更でヒューリスティック判定の結果が変わり得るので再解決 (override 反映)
    this.capability = resolveCapability(this.model, value, this.getCapabilityOverride(this.model));
    // Phase C-2 + D-4: 圧縮閾値・keepRecentMessages も追従
    this.contextManager.setThreshold(this.capability.compressionThreshold);
    this.contextManager.setKeepRecentMessages(this.capability.keepRecentMessages);
  }

  setModel(model: string): void {
    this.model = model;
    // 内部コンポーネントにも伝播（contextManager 内のcompressor、intent-classifier、evaluator）
    this.contextManager.setProvider(this.provider, model);
    this.intentClassifier.setProvider(this.provider, model);
    this.evaluator.setMainProvider(this.provider, model);
    // Phase A-3: model 切替で能力ティアを再解決 (override 反映)
    this.capability = resolveCapability(model, this.contextWindow, this.getCapabilityOverride(model));
    // Phase C-2 + D-4: 圧縮閾値・keepRecentMessages も tier 切替に追従
    this.contextManager.setThreshold(this.capability.compressionThreshold);
    this.contextManager.setKeepRecentMessages(this.capability.keepRecentMessages);
    logger.info(`[capability] ${formatCapabilityLabel(this.capability, model)} (${this.capability.reason})`);
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
    // 新 provider が attachToolBridge を持つなら (例: claude-agent-sdk) ToolRegistry を注入する。
    // ランタイム切替時に MCP bridge を再 attach しないと、 SDK に lllmAgent ツールが届かず
    // Claude が XML 形式の擬似 tool_use を text として吐き続ける状態になる。
    const bridgeable = provider as unknown as {
      attachToolBridge?: (r: ToolRegistry, e: ToolExecutor) => void;
    };
    if (typeof bridgeable.attachToolBridge === "function") {
      bridgeable.attachToolBridge(this.toolRegistry, this.toolExecutor);
    }
    // Phase A-3: provider 切替でも (model が変わる可能性あるため) capability を再解決 (override 反映)
    this.capability = resolveCapability(this.model, this.contextWindow, this.getCapabilityOverride(this.model));
    // Phase C-2 + D-4: 圧縮閾値・keepRecentMessages も追従
    this.contextManager.setThreshold(this.capability.compressionThreshold);
    this.contextManager.setKeepRecentMessages(this.capability.keepRecentMessages);
    logger.info(`[capability] ${formatCapabilityLabel(this.capability, this.model)} (${this.capability.reason})`);
  }

  /** Phase A: 現在の能力プロファイルを取得 (REPL の /capability コマンド用) */
  getCapability(): CapabilityProfile {
    return { ...this.capability };
  }

  /** 自動チェックポイント管理を取得 (REPL の /checkpoint コマンド用) */
  getCheckpointManager(): CheckpointManager {
    return this.checkpointManager;
  }

  /**
   * 古いチェックポイントセッションの掃除。 resume 解決後 (セッション identity 確定後) に
   * 呼ぶこと。 現在セッションは保護されるため、 復元対象を誤って消さない (H1 関連)。
   */
  runCheckpointMaintenance(): void {
    try {
      this.checkpointManager.pruneOldSessions();
    } catch {
      /* 掃除失敗は無視 */
    }
  }

  /**
   * Phase A-5: config.json の modelCapabilities から override を取得。
   * fine-tune モデル等で自動判定が誤る場合のユーザ調整手段。
   * 設定不在時は undefined を返す (= 自動判定のみ)。
   */
  private getCapabilityOverride(modelId: string): import("./capability-tier.js").CapabilityOverride | undefined {
    try {
      const cfg = loadConfig();
      const overrides = cfg.modelCapabilities;
      if (!overrides) return undefined;
      // 完全一致のみ (lowercase 比較で柔軟に)
      const id = modelId.toLowerCase().trim();
      for (const key of Object.keys(overrides)) {
        if (key.toLowerCase().trim() === id) return overrides[key];
      }
      return undefined;
    } catch {
      // config 読込失敗時は override なしで自動判定
      return undefined;
    }
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
/**
 * 経過秒数を曖昧でない日本語表記で返す。
 *   < 1 分     → "2秒"
 *   < 1 時間   → "1分30秒"
 *   ≥ 1 時間   → "1時間05分"
 *
 * 2026-05-14: 以前は "0:02" 形式だったが、 "0 分 02 秒" か "0 時 02 分" か曖昧で
 * ユーザーが「2 分経過したのに 0:02?」 と誤読する事例があったため改修。
 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}秒`;
  }
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}分${s.toString().padStart(2, "0")}秒`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}時間${m.toString().padStart(2, "0")}分`;
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


