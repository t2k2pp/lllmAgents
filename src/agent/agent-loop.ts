import chalk from "chalk";
import { createSpinner } from "../utils/spinner.js";
import { AgentEventBus, type TaskOutcome } from "./agent-events.js";
import { getInteractionBridge } from "./interaction-bridge-registry.js";
import { formatSelfCheck, rephraseUserIntent } from "./self-check-messages.js";
import { isLikelyPermanentToolError } from "./tool-error-classification.js";
import { globalTokenTracker } from "../cost/token-tracker.js";
import { globalCostCalculator } from "../cost/cost-calculator.js";
// プロンプト表示中はライブ領域を排他所有する (docs/tui-alternate-screen.md §4.3)
import { select } from "../cli/prompt-gate.js";
import { screen } from "../cli/screen-manager.js";
import { nonTTYReader } from "../utils/non-tty-reader.js";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { LLMProvider, ToolCall, ToolDefinition, ContentPart, Message } from "../providers/base-provider.js";
import type { ToolRegistry, ToolResult } from "../tools/tool-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { PermissionManager, RequestSource } from "../security/permission-manager.js";
import type { HookManager } from "../hooks/hook-manager.js";
import { MessageHistory, toSentMessage } from "./message-history.js";
import { generateHandoffNote, runHandoff, type HandoffResult } from "./handoff.js";
import {
  resolveCapability,
  formatCapabilityLabel,
  extractModelCandidates,
  TIER_CONTEXT_BUDGETS,
  type CapabilityProfile,
} from "./capability-tier.js";
import {
  checkContextWindowFits,
  checkUserInputFits,
  computeContextBudget,
  exceedsBoundaryLimit,
  exceedsForcedLimit,
  formatContextWindowTooSmall,
  formatUserInputTooLarge,
  measurePromptSize,
  type PromptSize,
  RequestGrowthTracker,
} from "./context-budget.js";
import {
  type BoundaryKind,
  formatReductionEventLine,
  type LastReductionEvent,
  type LastReductionSkip,
  previewReduction,
  type ReductionEventResult,
  type ReductionSkippedResult,
  type ReductionStatus,
  type ReductionTrigger,
  runReductionEvent,
  triggerLabel,
} from "./reduction-event.js";
import type { MainCallRequest } from "./reduction-summary.js";
import { type PrewarmOutcome, PrewarmRunner, type PrewarmTrigger, prewarmSkipReason } from "./prewarm.js";
import { ToolResultBatch } from "./tool-result-limit.js";
import { summarizeToolNames } from "./reduction-stages.js";
import { estimateMessageTokens, estimateTokens, estimateToolDefinitionTokens } from "./token-counter.js";
import { normalizeToolCalls } from "./tool-call-normalizer.js";
import { classifyTaskComplexity, recommendTier, explainRecommendation } from "./task-complexity.js";
import { buildSystemPrompt, type SkillInfo, type LLMProfiles, type SystemPromptOverrides } from "./system-prompt.js";
import { compressText } from "./compress-text.js";
import { loadMemory } from "./memory.js";
import { loadProjectInstructions } from "./project-context.js";
import {
  createSession,
  forkSession,
  appendSessionTerminalOutput,
  normalizeSessionTitle,
  saveSession,
  type SessionData,
  type SessionTerminalTranscript,
} from "./session-manager.js";
import type { RoomId } from "./room-types.js";
import { PlanManager } from "./plan-mode.js";
import { DEFAULT_SUMMARY_FAILURE_POLICY, type LLMEndpoint, type SamplingParams } from "../config/types.js";
import { makeLiveBinding, type LiveModelBinding } from "./model-drift.js";
import { loadConfig } from "../config/config-manager.js";
import { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import * as logger from "../utils/logger.js";
import { getOpsLogger } from "../utils/ops-logger.js";
import { LLMLogger } from "./llm-logger.js";
import { fingerprintPrompt } from "./prompt-fingerprint.js";
import {
  CacheMissCauseCollector,
  type CacheMissCauses,
  diagnoseCacheMiss,
  type PromptSend,
  mergeCacheMissCauses,
} from "./cache-miss.js";
import { setSideCallGate, setSideCallSink } from "./side-call.js";
import { isStructurallyIncomplete } from "../utils/incomplete-response.js";
import { formatToolCall, formatToolError } from "../cli/tool-summary.js";
import { formatBufferedResponseStatus } from "../cli/response-preview.js";
import { writeRuntimeError } from "../cli/runtime-diagnostic.js";
import { getFirstUseGuide, getFailureGuide, resetPerRequestGuides } from "./tool-guides.js";
import { IntentClassifier } from "./intent-classifier.js";
import { Evaluator } from "./evaluator.js";
import { judgeProgress, buildRecentSummary } from "./progress-judge.js";
import { checkCoherence, buildCoherenceNudge } from "./coherence-check.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
import type { ChatLogger } from "./chat-logger.js";
import { renderEditDiff, renderWriteDiff } from "../cli/diff-display.js";
import {
  gateLLMProvider,
  RunApiGate,
  type RequestRunPauseResult,
  type ResumeRunResult,
  type RunPauseSnapshot,
} from "./run-api-gate.js";
import {
  createDurableRunCheckpoint,
  parseDurableRunCheckpoint,
  validateDurableResume,
  type DurableRunCheckpoint,
} from "./durable-run-checkpoint.js";
import {
  type GoalDefinition,
  type EvaluationRecord,
  setGoal as setGoalSlot,
  getGoal as getGoalSlot,
  clearGoal as clearGoalSlot,
  hasGoal as hasGoalSlot,
  buildGoalSlotSection,
  getEvaluationHistory,
  restoreGoalState,
} from "./goal-slot.js";
import {
  type TodoItem,
  setTodos as setTodosFromGoal,
  getTodos as getTodosCurrent,
  setTodoChangeListener,
  clearTodos,
  buildTodoSection,
  formatTodosCurrent,
  getCurrentTodos,
  beginTodoRound,
} from "../tools/definitions/todo-write.js";

/**
 * チャネル会話スワップ用の会話状態 (A-5: docs/archive/channel-session-queue-design.md §2)。
 * 「履歴 + ToDo + Goal slot + mode」 の 4 点セット = session 境界と同じ範囲
 * (docs/todo-goal-lifecycle.md)。 MessageHistory はオブジェクト参照のまま保持する
 * (メッセージ再生ではないため thinking/ephemeral も無劣化)。
 */
export interface ConversationState {
  history: MessageHistory;
  todos: TodoItem[];
  goal: { definition: GoalDefinition; history: EvaluationRecord[] } | null;
  mode: AgentMode;
  /** 依頼 1 件ごとの増分 G の記録 (会話ごとに持つ。 docs/context-reduction-redesign.md §4.5) */
  requestGrowth: RequestGrowthTracker;
}

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
 * ループ点検の 1 区間を判定する (docs/archive/todo-request-elaboration.md 第 4 段)。
 * 進捗 (ToDo の完了 / ファイル変更) があれば ok。 進捗が無くても毎回違う呼び出し (調査を進めている) なら ok。
 * 進捗が無く、 区間内の呼び出しの半分以上が繰り返し (同じ名前 + 引数) なら "looping"。
 * 呼び出しが少なすぎる区間 (4 未満) は判断材料が無いので ok (テキストだけの空回りは別の仕組みで扱う)。
 */
export function judgeLoopWindow(calls: readonly string[], progressed: boolean): "ok" | "looping" {
  if (progressed || calls.length < 4) return "ok";
  return new Set(calls).size * 2 <= calls.length ? "looping" : "ok";
}

/**
 * ループの疑いで止めるときの報告文 (docs/archive/todo-request-elaboration.md 第 4 段)。
 * 今の依頼の ToDo から「終わったこと / 残り」 を並べ、 「続けて」 で再開できることを伝える。
 */
export function buildLoopStopReport(iterations: number, window: number): string {
  const todos = getCurrentTodos();
  const done = todos.filter((t) => t.status === "completed").map((t) => `- ${t.content}`);
  const left = todos.filter((t) => t.status !== "completed").map((t) => `- ${t.content}`);
  const head =
    `⏸ ループの疑いがあるため、 ここで一旦止めました (作業 ${iterations} 回)。\n` +
    `直近 ${window * 2} 回、 ToDo の完了もファイルの変更も無く、 同じ呼び出しの繰り返しが続きました ` +
    `(途中で一度、 やり方を変えるよう促しています)。`;
  const lines = [head];
  if (todos.length > 0) {
    lines.push("", `終わったこと (${done.length}):`, ...(done.length > 0 ? done : ["- なし"]));
    lines.push("", `残り (${left.length}):`, ...(left.length > 0 ? left : ["- なし"]));
  }
  lines.push("", "「続けて」 と送ると、 ここから再開します。 方針を変える場合はそれも一緒に伝えてください。");
  return lines.join("\n");
}
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

export const MAX_STEERING_MESSAGE_CHARS = 4000;
export const MAX_PENDING_STEERING_MESSAGES = 20;

export type QueueSteeringResult = {
  status: "queued" | "not_running" | "invalid_message" | "message_too_long" | "queue_full";
  pending: number;
};

export class AgentLoop {
  private history: MessageHistory;
  private toolExecutor: ToolExecutor;
  private session: SessionData;
  private planManager: PlanManager | null = null;
  /** Discord Interaction Server などから並行処理を避けるためのフラグ */
  public isProcessing = false;
  /** CLIで現在のrunへ反映する追加入力。LLM reply/tool完了の安全な境界でFIFO注入する。 */
  private pendingSteeringMessages: string[] = [];
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
    filesChanged: new Set<string>(),
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  };
  /** true: テキストをリアルタイムにストリーミング表示。false: スピナー+完了後Markdownレンダリング */
  private streamingDisplay: boolean = false;
  /** 現在処理中のリクエストの発生元 */
  private currentSource: RequestSource = "cli";
  /** Ctrl+C などによる中断フラグ */
  private _aborted = false;
  /**
   * P4 (docs/async-surface-permission-delivery-design.md 5.4): サーキットブレーカ。
   * 同一ツールが同一エラーで繰り返し失敗 (特に 401/認証/権限の恒久失敗) したら run を打ち切り、
   * 正直に報告する。 警告だけ出して回し続ける旧挙動 (徹夜暴走の一因) を是正する。
   */
  private _circuitBreak: { tool: string; error: string } | null = null;
  /**
   * 進行中 LLM 呼び出しの AbortController。 abort() で HTTP 接続ごと切断する。
   * フラグ (_aborted) だけだとクライアントが読むのをやめるだけでサーバ側の生成が
   * 走り続け、 後続リクエストが詰まる (llama.cpp はシングルスロット直列処理)。
   */
  private llmAbortController: AbortController | null = null;
  /**
   * 先読み (docs/context-reduction-redesign.md §9)。 裏で 1 つだけ走らせ、 本体呼び出し・脇の呼び出しを終わりまで待たせる。
   * abort() (Esc) は先読みも切る。
   */
  private readonly prewarm = new PrewarmRunner({
    onWait: (who) => {
      const line = `先読み (サーバへの会話の読み込み) が終わるのを待ってから${who}を送ります。 Esc で中断できます`;
      console.log(chalk.dim(`  ⏳ ${line}`));
      this.notice("info", line);
    },
  });
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
   * cache_miss の判定で比べる相手 (docs/context-reduction-redesign.md §10.2): 前回の本体呼び出しか、 その後に送り終えた先読み。
   * 入力トークン数 (キャッシュ分を含む全体。 サーバが usage を返さなかったら undefined) と並びの指紋を持つ。
   */
  private lastPromptSend: PromptSend | undefined;
  /** 本体呼び出しの間に起きた整理イベント・脇の呼び出しをためる箱 (cache_miss の原因欄) */
  private readonly cacheMissCauses = new CacheMissCauseCollector();
  /**
   * 直前の本体呼び出しの実数 (入力の全体と出力) と、 送った時点の履歴の位置。 次の P の土台にする
   * (docs/context-reduction-redesign.md §4.1)。 間に履歴の書き換え (revision の変化)・履歴の載せ替えがあったら使わない。
   * サーバが usage を返さなかったら null。
   */
  private lastMainCall: {
    history: MessageHistory;
    revision: number;
    sentCount: number;
    promptTokens: number;
    outputTokens: number;
  } | null = null;
  /**
   * 依頼 1 件ごとの増分 G の記録 (docs/context-reduction-redesign.md §4.5)。 run() の始めに beginRequest、 本体呼び出しの応答ごとに
   * noteMainCall、 依頼の途中の整理イベントが noteReduction、 run() が終わり方の決まった終わり方をしたら endRequest。
   * セッションに保存し (saveCurrentSession)、 再開で戻す (restoreSession)。 会話の載せ替え (importConversation) では会話ごとに持ち替える。
   */
  private requestGrowth = new RequestGrowthTracker();
  /**
   * 直近の整理イベント (/compact と /context の表示用。 利用者向けだけで、 モデルには見せない)。
   * 整理した履歴オブジェクトと組にして持ち、 会話の載せ替え・再開の後は出さない。
   */
  private lastReduction: { history: MessageHistory; event: LastReductionEvent | LastReductionSkip } | null = null;
  /**
   * 規則 2 (§4.4) の、 記録して次の本体呼び出しの直前に判定する強い区切り (ToDo の全部完了・Goal の達成)。
   * 依頼の終わり・新しい依頼の判定をしたら、 それに含まれるので捨てる。
   */
  private pendingBoundary: Extract<BoundaryKind, "todos-complete" | "goal-achieved"> | null = null;
  /**
   * 前の依頼が正常に終わり、 依頼の終わりの判定 (規則 2) を済ませたか。 済んでいれば「新しい依頼が届いた」 では判定しない。
   * 中断・エラー・一時停止・セッションの再開・会話の載せ替えのあとは false (= 次の依頼の始まりで判定する)。
   * ToDo が残ったままの応答完了 (弱い区切り) も「正常に終わった」 に数え、 新しい依頼で改めて判定しない (§4.4 の表)。
   */
  private requestEndSettled = false;
  /** 整理イベント ID の通し番号 */
  private reductionSeq = 0;
  /**
   * いま処理中の依頼を始めた利用者の発言 (run() の間だけ)。 整理イベントの前処理で
   * 「これより前が終わった依頼」 の境目にする。 依頼の外では null。
   */
  private currentRequestMessage: Message | null = null;
  /**
   * P0-A: 直近 FAILURE_WINDOW 反復内のツール失敗履歴。 同じ (signature, error) が
   * 2 回以上出たら「同じ轍を踏んでいる」 と判定し self-check を注入する。
   * 既存の MAX_REPEAT_TOOL=3 (連続検出) では grep/read を間に挟まれると無効化されるため、
   * sliding window で「間に他ツールが挟まっても」 失敗の繰り返しを検出する補強。
   */
  private recentFailures: Array<{ iteration: number; signature: string; error: string }> = [];
  /** 同一span内でstuck-loop警告を注入済みのsignature。履歴は保持して停止閾値まで数える。 */
  private stuckIntervenedSignatures = new Set<string>();
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
  /** P1-B: 1 user span 内の ToDo 計画の書き換え回数 (todo_append / todo_delete) */
  private todoUpdateCount = 0;
  /** P1-B: plan/todo の過多警告を既に注入したか (1 user span に 1 回だけ) */
  private planTodoWarned = false;
  /**
   * P3-A: 現在の対話レジスター。 system-prompt の規約により、 モデルがタスク開始時に
   * 「このタスクは X として進めます」 と宣言する。 その宣言を読み取り、 standard 以上でだけ働く
   * 完了ゲート (Q→A 進捗 / コヒーレンス) の発火条件に使う。 作業回数の上限には使わない (上限は撤廃済み)。
   */
  private currentRegister: "explore" | "rough" | "standard" | "production" | "unknown" = "unknown";
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
  private terminalTranscriptBridge: {
    restore: (
      saved: unknown,
      messages: Message[],
    ) => {
      mode: "exact" | "recovered" | "legacy" | "invalid";
      transcript: SessionTerminalTranscript;
      recoveredMessageCount: number;
    };
  } | null = null;
  /** Evaluator（成果物の独立レビュー） */
  private evaluator: Evaluator;
  /** LLMプロファイル情報（システムプロンプト再構築用。/models Edit 等の更新時に差し替え可） */
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
  /**
   * いま動いている provider を生成したときの接続情報 (docs/model-apply-immediacy.md §3.1)。
   * config の設定値と比較して「設定したのに反映されていない」 を検出するために持つ。
   */
  private liveBinding: LiveModelBinding | null = null;
  /** liveBinding を model 単体切替時にも正しく再生成するための元 endpoint。 */
  private liveEndpoint: LLMEndpoint | null = null;
  /** run pauseをmain AgentLoopのAPIだけへ適用し、sub-agentへ伝播させないためraw providerも保持する。 */
  private rawProvider: LLMProvider;
  /** context整理・分類器を含む全main LLM chat経路をrun gateで包んだprovider。 */
  private provider: LLMProvider;
  private runApiGate: RunApiGate;
  /** resume開始直前のpairing済み履歴。例外時に未確定tool callをmemoryへ残さないためのrollback元。 */
  private durableResumeBaseline: SessionData | null = null;

  constructor(
    provider: LLMProvider,
    private model: string,
    private toolRegistry: ToolRegistry,
    private permissions: PermissionManager,
    contextWindow: number,
    hookManager?: HookManager,
    skills?: SkillInfo[],
    agentId: string = "main",
    sessionId?: string,
    streamingDisplay: boolean = false,
    maxParallelTools: number = 1,
    hasSecondLLM: boolean = false,
    samplingParams: SamplingParams = {},
    hasObsidian: boolean = false,
    secondLLMManager: SecondLLMManager | null = null,
    llmProfiles?: LLMProfiles,
    private readonly safeMode: boolean = false,
  ) {
    this.runApiGate = new RunApiGate(() => {
      screen.clearTransientStatus();
      console.log(
        chalk.cyan(
          `
  ⏸ 一時停止しました。会話と再開地点を session ${this.session.meta.id} に保存済みです。アプリ・PCを終了しても再開できます。`,
        ),
      );
      console.log(
        chalk.dim(
          "  再開: このまま /run resume。終了した場合は、次回同じフォルダで起動すると再開するか確認します。background task / second LLMは対象外です (/tasks)。",
        ),
      );
      this.notice("info", "foreground runを一時停止 (再開地点を保存済み)");
    });
    this.rawProvider = provider;
    this.provider = gateLLMProvider(provider, this.runApiGate);
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
    const systemPrompt = buildSystemPrompt(
      skills,
      hasSecondLLM,
      hasObsidian,
      llmProfiles,
      this.capability.tier,
      undefined,
      this.safeMode,
    );
    // 既存 goal-slot 状態を反映 (process 内で /goal-seek 実行後の AgentLoop 再生成時に継承)。
    if (hasGoalSlot()) {
      this.currentMode = "goal-seek";
    }
    // 戦略 ToDo Phase 1 (docs/strategic-todo-design.md §2.2 / §3.1):
    // 準システムプロンプト動的合成。 base + goal section + todo section を毎呼出で fresh に作る。
    // composer は MessageHistory が呼ぶたびに最新の goal-slot / todos を読んで合成する。
    // Goal / ToDo は system ではなく、 変化時に末尾へ添付する状態通知になる (docs/prompt-prefix-stability.md)。
    this.history = new MessageHistory(systemPrompt);
    this.history.setSystemPromptComposer((base) => this.composeQuasiSystemPrompt(base));
    // 整理しても次の呼び出しが入らない枠なら、 ここで理由と必要量を示して止める (docs/context-reduction-redesign.md §6.3)
    this.assertContextWindowFits(this.capability, contextWindow, model);
    // ToDo の遷移フック。 全部完了 (規則 2 の強い区切り) を記録する。 tool の通り道に検出を 1 本足すだけで新しいループは作らない
    setTodoChangeListener((before, after) => this.onTodoChange(before, after));
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
    this.toolExecutor = new ToolExecutor(toolRegistry, permissions, hookManager, undefined, this.checkpointManager);
    this.toolExecutor.setParallelExecutionAllowed(this.maxParallelTools > 1);
    this.session = createSession(model);
    // チェックポイントは resume を跨いで安定な session.meta.id で採番する (H1)
    this.checkpointManager.rebind(this.session.meta.id);
    this.llmLogger = new LLMLogger(agentId, sessionId);
    // 5.5: 各ログレコードに roomId(現セッションの Room)/surface(発信面) を注入する。
    // 単一 AgentLoop を全 Room/面で共有するため、 これが無いと事後解析で REPL/Discord/Slack や
    // どの Room の run かを判別できない (docs/async-surface-permission-delivery-design.md R-4)。
    this.llmLogger.setContext(() => ({
      roomId: this.session.meta.room,
      surface: this.currentSource,
    }));
    // 脇の呼び出し (意図の分類・要約・サブエージェント 等) はすべてメインのセッションログに side_call として残し、
    // 次の本体呼び出しでキャッシュが外れたときの原因欄に使う (docs/context-reduction-redesign.md §10.3)。
    setSideCallSink({
      recordSideCall: (record) => {
        this.llmLogger.logSideCall(record);
        this.cacheMissCauses.noteSideCall(record.purpose);
        // 送り終えた先読みは、 次の本体呼び出しの外れの判定で比べる相手になる (先読みが効いたかをそこで見る)。
        // それより前に起きたこと (整理・脇の呼び出し・書き換え) は先読みが読み込んだ並びに入っているので、 原因から外す
        if (record.purpose === "prewarm" && record.error === undefined && record.fingerprint) {
          this.lastPromptSend = { kind: "prewarm", promptTokens: record.tokensIn, fingerprint: record.fingerprint };
          this.cacheMissCauses.restartFrom(this.history, this.history.pendingRewriteReasonCount());
        }
      },
    });
    // 先読み中は脇の呼び出しを送らない (スロットが 1 つのサーバでは先読みした中身を追い出す。 §9.2)
    setSideCallGate(this.prewarm);
    this.intentClassifier = new IntentClassifier(this.provider, model);
    this.evaluator = new Evaluator(secondLLMManager, this.provider, model);
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
            const toolSummary =
              toolCalls && toolCalls.length > 0 ? toolCalls.map((tc) => tc.function.name).join(", ") : undefined;
            cl.logAssistant(content, toolSummary);
          }
        : null,
    );
  }

  /** UI層が所有するstdout scrollbackをsession保存・復元へ接続する。 */
  setTerminalTranscriptBridge(bridge: {
    restore: (
      saved: unknown,
      messages: Message[],
    ) => {
      mode: "exact" | "recovered" | "legacy" | "invalid";
      transcript: SessionTerminalTranscript;
      recoveredMessageCount: number;
    };
  }): void {
    this.terminalTranscriptBridge = bridge;
  }

  /** OutputRouterが確定stdoutを現在ロード中のsessionへ振り分ける。 */
  recordTerminalOutput(text: string): void {
    this.session.terminalTranscript = appendSessionTerminalOutput(this.session.terminalTranscript, text);
  }

  /** harness_notice イベントの発火ヘルパー (CLI 表示とは独立。 docs/agent-events-design.md §3) */
  private notice(level: "info" | "warn" | "error", message: string): void {
    this.events.emit("harness_notice", { level, message });
  }

  /** A-6: file_write / file_edit の成功を run 統計に記録する (task_complete の完了報告用) */
  private trackFileChange(toolCall: ToolCall, success: boolean): void {
    if (!success) return;
    const name = toolCall.function.name;
    if (name !== "file_write" && name !== "file_edit") return;
    try {
      const args = JSON.parse(toolCall.function.arguments ?? "{}");
      const fp = (args.file_path ?? args.path) as string | undefined;
      if (fp) this.runStats.filesChanged.add(fp);
    } catch {
      /* parse 失敗は無視 (統計用途のみ) */
    }
  }

  /** 実行中の処理を中断する（Esc / Ctrl+C など）。進行中の LLM 接続も即座に切断する */
  abort(): void {
    this._aborted = true;
    this.runApiGate.abortRun();
    // HTTP 接続を切断してサーバ側の生成も止める。 これが無いと llama.cpp が
    // 中断済み生成を完走するまで後続リクエストが待たされ「固まった」 ように見える。
    this.llmAbortController?.abort();
    // 先読みも切る (docs/context-reduction-redesign.md §9.2)
    this.prewarm.abort();
  }

  /** 中断フラグをリセットする（次の run() 開始前に呼ぶ） */
  clearAbort(): void {
    this._aborted = false;
  }

  isAborted(): boolean {
    return this._aborted;
  }

  /** 現在のCLI foreground runを、進行中APIの完了後に協調停止する。 */
  requestRunPause(): RequestRunPauseResult | { status: "unavailable"; snapshot: RunPauseSnapshot; reason: string } {
    if (!this.liveBinding) {
      return {
        status: "unavailable",
        snapshot: this.runApiGate.snapshot(),
        reason: "model/provider bindingが未確定です。/model apply後に再試行してください",
      };
    }
    return this.runApiGate.requestPause();
  }

  /** pause予約を取り消す、またはAPI境界で停止中のrunを再開する。 */
  resumeRun(): ResumeRunResult | { status: "checkpoint_save_failed"; snapshot: RunPauseSnapshot; reason: string } {
    const snapshot = this.runApiGate.snapshot();
    if (snapshot.state === "paused") {
      const parsed = parseDurableRunCheckpoint(this.session.runCheckpoint);
      if (!parsed.ok) {
        return { status: "checkpoint_save_failed", snapshot, reason: parsed.reason };
      }
      parsed.checkpoint.state = "resuming";
      parsed.checkpoint.savedAt = new Date().toISOString();
      this.session.runCheckpoint = parsed.checkpoint;
      try {
        this.saveCurrentSession();
        this.durableResumeBaseline = structuredClone(this.session);
      } catch (error) {
        return {
          status: "checkpoint_save_failed",
          snapshot,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return this.runApiGate.resume();
  }

  getRunPauseSnapshot(): RunPauseSnapshot {
    return this.runApiGate.snapshot();
  }

  getDurableRunCheckpoint():
    | { status: "none" }
    | { status: "invalid"; reason: string }
    | { status: "durable_paused" | "resuming"; checkpoint: DurableRunCheckpoint; differences: string[] } {
    if (this.session.runCheckpoint === undefined) return { status: "none" };
    const parsed = parseDurableRunCheckpoint(this.session.runCheckpoint);
    if (!parsed.ok) return { status: "invalid", reason: parsed.reason };
    return {
      status: parsed.checkpoint.state,
      checkpoint: structuredClone(parsed.checkpoint),
      differences: validateDurableResume(parsed.checkpoint, {
        sessionId: this.session.meta.id,
        liveBinding: this.liveBinding,
      }),
    };
  }

  beginDurableRunResume():
    | { status: "started"; continuation: Promise<void> }
    | { status: "not_found" | "invalid" | "blocked_unknown_progress" | "incompatible" | "busy"; reason: string } {
    if (this.isProcessing || this.runApiGate.snapshot().state !== "idle") {
      return { status: "busy", reason: "foreground runがすでに実行中です" };
    }
    const current = this.getDurableRunCheckpoint();
    if (current.status === "none")
      return { status: "not_found", reason: "復元済みsessionに一時停止の再開地点がありません" };
    if (current.status === "invalid") return { status: "invalid", reason: current.reason };
    if (current.status === "resuming") {
      return {
        status: "blocked_unknown_progress",
        reason:
          "前回はresume開始後に終了しました。API/toolの到達点を確定できないため自動再実行しません。/run inspect後、/run discardして新しい依頼として続けてください",
      };
    }
    if (current.differences.length > 0) return { status: "incompatible", reason: current.differences.join(" / ") };

    const checkpoint = current.checkpoint;
    checkpoint.state = "resuming";
    checkpoint.savedAt = new Date().toISOString();
    this.session.runCheckpoint = checkpoint;
    try {
      this.saveCurrentSession();
      this.durableResumeBaseline = structuredClone(this.session);
    } catch (error) {
      return {
        status: "invalid",
        reason: `resume開始状態を保存できません: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      status: "started",
      continuation: this.run("", { source: "cli", durableResume: checkpoint }),
    };
  }

  discardDurableRunCheckpoint(): { status: "discarded" | "not_found" | "busy"; reason?: string } {
    if (this.isProcessing) return { status: "busy", reason: "foreground run実行中はdiscardできません" };
    if (this.session.runCheckpoint === undefined)
      return { status: "not_found", reason: "一時停止の再開地点がありません" };
    delete this.session.runCheckpoint;
    this.saveCurrentSession();
    return { status: "discarded" };
  }

  /**
   * 実行中の通常turnへ追加入力を予約する。生成やtoolを強制中断せず、次の安全な境界で反映する。
   * queue上限を超えた入力を別モードへ黙って落とさないため、呼出元が表示できる状態を返す。
   */
  queueSteering(message: string): QueueSteeringResult {
    // 同じAgentLoopをDiscord/Slackの別Roomも共有する。REPLが自分のRoomRunQueue順番を
    // 待っている間に別surfaceへ誤注入しないよう、active CLI runだけを対象にする。
    if (!this.isProcessing || this.currentSource !== "cli") {
      return { status: "not_running", pending: this.pendingSteeringMessages.length };
    }
    const normalized = message.trim();
    if (!normalized) return { status: "invalid_message", pending: this.pendingSteeringMessages.length };
    if (normalized.length > MAX_STEERING_MESSAGE_CHARS) {
      return { status: "message_too_long", pending: this.pendingSteeringMessages.length };
    }
    if (this.pendingSteeringMessages.length >= MAX_PENDING_STEERING_MESSAGES) {
      return { status: "queue_full", pending: this.pendingSteeringMessages.length };
    }
    this.pendingSteeringMessages.push(normalized);
    return { status: "queued", pending: this.pendingSteeringMessages.length };
  }

  getPendingSteeringCount(): number {
    return this.pendingSteeringMessages.length;
  }

  /** abort/errorで境界へ届かなかった入力を、REPLが次turn用FIFOへ救出する。 */
  takePendingSteering(): string[] {
    return this.pendingSteeringMessages.splice(0);
  }

  async run(
    userMessage: string | ContentPart[],
    options?: { source?: RequestSource; durableResume?: DurableRunCheckpoint },
  ): Promise<void> {
    const durableResume = options?.durableResume;
    this.currentSource = options?.source ?? "cli";
    this.runApiGate.beginRun(this.currentSource);
    this.isProcessing = true;
    this._aborted = false;
    this._circuitBreak = null;
    this.runStats = {
      startMs: Date.now(),
      iterations: 0,
      toolsExecuted: 0,
      finalText: "",
      outcome: "incomplete",
      filesChanged: new Set<string>(),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
    this.events.emit("task_start", {
      source: this.currentSource,
      prompt: durableResume
        ? durableResume.run.userMessageText
        : typeof userMessage === "string"
          ? userMessage
          : userMessage
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join(" "),
      timestamp: this.runStats.startMs,
    });
    // P0-A: ユーザー発話のたびに失敗履歴をリセット (前ターンの失敗を引き摺らない)
    this.recentFailures = [];
    this.stuckIntervenedSignatures.clear();
    // P1-A/B: bash累積時間 / plan/todo 呼出回数も user span 単位でリセット
    this.bashCumulativeMs = 0;
    this.bashCumulativeWarned = false;
    this.planModeEntries = 0;
    this.todoUpdateCount = 0;
    this.planTodoWarned = false;
    // P3-A: レジスターは user 発話ごとに再判定 (前タスクのレジスターを引き継がない)
    this.currentRegister = "unknown";
    try {
      if (!durableResume) {
        // 入りきらない入力は履歴に入れずに断る (ToDo の区切りなど依頼ごとの準備もしない)
        const refusal = this.checkUserInput(userMessage);
        if (refusal) {
          console.log(chalk.red(`\n  ${refusal}`));
          this.notice("error", refusal);
          this.runStats.outcome = "error";
          return;
        }
        // 規則 2 の「新しい依頼が届いた」 (docs/context-reduction-redesign.md §4.4)。 前の依頼の終わりで判定していないとき
        // (中断・エラー・再開のあと) だけ、 新しい発言を履歴に入れる前に判定する (前の依頼は全部終わった依頼として扱う)
        await this.judgeNewRequestBoundary();
        // 依頼 1 件の増分 G を測り始める (前の依頼が終わっていなければ、 そこまでを 1 件として記録してから)
        this.requestGrowth.beginRequest();
        this.requestEndSettled = false;
        // 依頼の洗い出しガイドは依頼ごとに出し直す (docs/request-elaboration-design.md §5.5)
        resetPerRequestGuides();
        // ToDo を依頼ごとに区切る: 前の依頼で完了した項目を一覧・完了カウントから外す (削除はしない)
        beginTodoRound();
        this.history.addUserMessage(userMessage);
      }
      // 整理イベントの前処理の境目 (これより前が終わった依頼)。 再開では履歴にある最後の利用者の発言
      this.currentRequestMessage =
        this.history
          .getRawMessages()
          .filter((m) => m.role === "user" && m.ephemeral !== true)
          .at(-1) ?? null;
      // チャットログ記録
      if (this.chatLogger && !durableResume) {
        const userText =
          typeof userMessage === "string"
            ? userMessage
            : (userMessage as ContentPart[])
                .filter((p): p is { type: "text"; text: string } => p.type === "text")
                .map((p) => p.text)
                .join(" ");
        this.chatLogger.logUser(userText);
      }
      // ユーザーメッセージのテキスト部分を抽出（タスク判定用）
      let userMessageText = durableResume
        ? durableResume.run.userMessageText
        : typeof userMessage === "string"
          ? userMessage
          : (userMessage as ContentPart[])
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join(" ");
      const applyPendingSteering = (boundary: "reply" | "tool"): number => {
        const messages = this.takePendingSteering();
        if (messages.length === 0) return 0;
        for (const message of messages) {
          this.history.addUserMessage(message);
          this.chatLogger?.logUser(message);
        }
        userMessageText = [userMessageText, ...messages].join("\n");
        const boundaryLabel = boundary === "tool" ? "tool完了" : "応答";
        console.log(chalk.dim(`  ▶ 追加入力 ${messages.length} 件を${boundaryLabel}境界で現在の処理へ反映します。`));
        this.notice("info", `追加入力 ${messages.length} 件を${boundaryLabel}境界で反映`);
        return messages.length;
      };
      // Phase E-3: タスク複雑度を分類して、 不一致なら model 推奨を 1 行ログ。
      // 自動切替はしない (ユーザの明示操作 = /model を尊重)。
      if (!durableResume) {
        try {
          const complexity = classifyTaskComplexity(userMessageText);
          const recommended = recommendTier(complexity, this.capability.tier);
          if (recommended) {
            const reason = explainRecommendation(complexity, this.capability.tier, recommended);
            console.log(
              chalk.dim(
                `  [model 推奨] ${this.capability.tier} → ${recommended} (complexity=${complexity}). ${reason}`,
              ),
            );
            console.log(chalk.dim(`  → 切替する場合: /model <name> または /swap`));
          }
        } catch {
          /* 推奨は best-effort、 失敗しても続行 */
        }
      }
      // <think>タグフィルター（古いOllama向け、ストリーム跨ぎ対応）
      const filterThinkingTags = createThinkingFilter();
      let emptyResponseRetries = durableResume?.run.emptyResponseRetries ?? 0;
      const MAX_EMPTY_RETRIES = 3;
      let codeBlockRetried = durableResume?.run.codeBlockRetried ?? false;
      let hasExecutedTools = durableResume?.run.hasExecutedTools ?? false; // この run() 内でツールを1回でも実行したか
      /** 直前のツール呼び出しシグネチャ（反復検出用） */
      let lastToolSignature = durableResume?.run.lastToolSignature ?? "";
      let repeatToolCount = durableResume?.run.repeatToolCount ?? 0;
      /** 検証待ちコードファイルのリスト（file_write/file_edit後、bash未実行ならここに溜まる） */
      let pendingVerification: string[] = [...(durableResume?.run.pendingVerification ?? [])];
      /** Evaluatorレビュー待ちファイルのリスト（コード+ドキュメント両方） */
      let pendingEvalFiles: string[] = [...(durableResume?.run.pendingEvalFiles ?? [])];
      /**
       * 自己点検の累積回数（統合カウンタ）。
       * verification, evaluator, text-only, code-block の4種類の懸念すべてで共有する。
       * 上限到達で追加の自己点検注入は停止しターン終了。
       */
      let selfCheckRounds = durableResume?.run.selfCheckRounds ?? 0;
      // Phase C-2: tier 別に自己点検回数を変える。 T1=3 / T2=2 / T3=1。
      // T3 は scaffolding を増やしても改善しないため早めにユーザに戻す。
      const MAX_SELF_CHECK_ROUNDS = this.capability.maxSelfCheckRounds;
      const MAX_REPEAT_TOOL = 3; // 同じツール呼び出しがN回連続で失敗したら中断

      // 2026-05-16 (docs/strategic-todo-design.md 議論): base harness の persistence 機構。
      // 既存 self-check と独立した並列カウンタ。 standard 以上のレジスターでのみ発火。
      let progressGateRetries = durableResume?.run.progressGateRetries ?? 0; // Axis (1) Q→A 進捗 gate (response_complete 時)
      let coherenceGateRetries = durableResume?.run.coherenceGateRetries ?? 0; // Axis (2a) thinking-text コヒーレンス
      const MAX_NEW_GATE_RETRIES = 2; // 各 gate の上限 (自己点検と独立)

      // 作業回数・文字数の上限は設けない (docs/archive/todo-request-elaboration.md 第 4 段)。 Claude Code と同じく、
      // 止まるのは完了・ユーザー操作・本当に必要な確認のときだけ。 代わりに loopCheckInterval 回ごとに
      // 「ループしていないか」 を点検する:
      //   - 直近の区間で ToDo の完了かファイル変更があった、 または毎回違う呼び出しをしている → 何もしない
      //   - 進捗が無く、 同じ呼び出しが半分以上 → 1 回目はモデルに振り返らせる (ユーザー確認なし)
      //   - 次の点検でも同じ → 止めて、 終わったこと・残り・理由を報告する (ここだけが必要な確認)
      // 同じ呼び出しの連続 (MAX_REPEAT_TOOL) と同じエラーの再発 (stuck-loop / サーキットブレーカ) は従来どおり別途検知する。
      const loopCheckInterval = Math.max(1, this.capability.loopCheckInterval);
      const startIteration = durableResume?.run.nextIteration ?? 0;
      const progressMark = (): string =>
        `${getCurrentTodos().filter((t) => t.status === "completed").length}:${this.runStats.filesChanged.size}`;
      let lastProgressMark = progressMark();
      /** 点検区間内のツール呼び出し (名前 + 引数)。 繰り返しの割合を見る */
      const windowCalls: string[] = [];
      let loopStrikes = 0;
      const pauseAtBoundaryIfRequested = async (nextIteration: number): Promise<boolean> => {
        if (!this.runApiGate.isPauseRequested()) return true;
        applyPendingSteering("tool");
        const liveBinding = this.liveBinding;
        if (!liveBinding) {
          this.runApiGate.resume();
          throw new Error("一時停止に必要なmodel/provider bindingが未確定です。/model apply後に再試行してください");
        }
        this.session.runCheckpoint = createDurableRunCheckpoint({
          sessionId: this.session.meta.id,
          liveBinding,
          run: {
            userMessageText,
            nextIteration,
            emptyResponseRetries,
            codeBlockRetried,
            hasExecutedTools,
            lastToolSignature,
            repeatToolCount,
            pendingVerification,
            pendingEvalFiles,
            selfCheckRounds,
            progressGateRetries,
            coherenceGateRetries,
          },
        });
        try {
          this.saveCurrentSession();
        } catch (error) {
          this.runApiGate.resume();
          throw new Error(
            `一時停止の再開地点を保存できません: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return await this.runApiGate.pauseAtBoundary();
      };
      for (let iteration = startIteration; ; iteration++) {
        if (iteration > startIteration && (iteration - startIteration) % loopCheckInterval === 0) {
          const mark = progressMark();
          const progressed = mark !== lastProgressMark;
          lastProgressMark = mark;
          const verdict = judgeLoopWindow(windowCalls, progressed);
          windowCalls.length = 0;
          if (verdict === "ok") {
            loopStrikes = 0;
          } else if (++loopStrikes === 1) {
            console.log(
              chalk.dim(
                `  [ループ点検] 直近 ${loopCheckInterval} 回で進捗が無く同じ呼び出しが多い — 振り返りを促します`,
              ),
            );
            this.history.addUserMessage(
              `[ハーネス] 直近 ${loopCheckInterval} 回の作業で、 ToDo の完了もファイルの変更も無く、 同じ呼び出しの繰り返しが多くなっています。\n` +
                `同じことを繰り返していないか振り返ってください。 繰り返しているなら、 やり方を変える (原因を調べ直す・別の手段を使う・前提を確かめる)。\n` +
                `必要な調査を進めているだけなら、 そのまま続けてかまいません。 ユーザーの判断が本当に必要なときだけ ask_user を使ってください。`,
              { ephemeral: true },
            );
          } else {
            break;
          }
        }
        this.currentIteration = iteration;
        this.runStats.iterations = iteration + 1;
        // 中断チェック
        if (this._aborted) {
          // P4 (5.4): サーキットブレーカ起因の中断は、 generic な中断でなく「何が・なぜ恒久的に
          // 失敗したか」を最終応答として正直に届ける (silent な打ち切りにしない)。
          const cb = this.takeCircuitBreak();
          if (cb) {
            const report =
              `⛔ ${cb.tool} が同じエラーで繰り返し失敗したため、処理を打ち切りました。\n` +
              `エラー: ${cb.error.slice(0, 300)}\n` +
              `待っても直らない種類の失敗の可能性が高いです。原因（権限/接続/設定）を解消してから再依頼してください。`;
            console.log(chalk.red("\n  " + report.replace(/\n/g, "\n  ")));
            this.history.addAssistantMessage(report);
            this.runStats.finalText = report;
            this.events.emit("assistant_text", { text: report, final: true });
            this.recordSpanEnd("circuit_break");
            return;
          }
          console.log(chalk.yellow("\n  (処理を中断しました)"));
          // 中断ターンを履歴上で可視化する。 これが無いと「応答の無い user メッセージ」 が
          // 残り、 再送信のたびに同文が重複蓄積してモデルを混乱させる (2026-06-12 ログで実証)。
          this.appendAbortMarker("");
          this.recordSpanEnd("user_abort");
          return;
        }
        // 一時停止は、前のAPI応答と開始済みtool resultが履歴へ確定した後、
        // 次のmain LLM APIを開始する直前だけでcheckpointする。
        if (!(await pauseAtBoundaryIfRequested(iteration))) return;
        // Call LLM with retry
        let textContent = "";
        let thinkingContent = "";
        const toolCalls: ToolCall[] = [];
        let hasStartedOutput = false;
        let thinkingSpinner: ReturnType<typeof createSpinner> | null = null;
        let success = false;

        let receivedTokens = 0; // スピナーモード: 受信トークンカウンター
        let visibleTextContent = ""; // スピナーモード: thinking除去済みのlive preview元
        let thinkingStarted = false; // ストリーミングモード: [思考]ヘッダー表示済みフラグ
        let finishReason = "stop"; // LLMの終了理由（"length"なら出力が途中で切れた）
        let tokensIn: number | undefined;
        let tokensOut: number | undefined;
        let tokensCached: number | undefined;
        // 前回の本体呼び出しからの間に起きたこと (cache_miss の原因欄)。 再試行で送り直したときは合わせて持つ。
        let missCauses: CacheMissCauses = { reductionEventIds: [], rewriteReasons: [], sideCallPurposes: [] };
        // LLM呼び出しループ: 接続エラー時は自動リトライ、その他はユーザーに判断を委ねる
        let connectionRetries = 0;

        while (!success) {
          // context整理中やconnection retry待ちにpause要求が届いた場合も、次のmain APIを出す前に保存する。
          if (!(await pauseAtBoundaryIfRequested(iteration))) return;
          // 先読み中なら終わるまで待つ (切断しない。 切るとそれまでの読み込みが無駄になる。 §9.2)。 Esc は先読みも切り、 下の中断の確認で止まる
          await this.prewarm.wait("本体の呼び出し");
          // 規則 2 の記録済みの強い区切り (ToDo の全部完了・Goal の達成) と規則 1 (docs/context-reduction-redesign.md §4.4)。
          // 規則 1: 本体呼び出しの直前に P + R > W なら、 先に整理イベントを行う。 失敗したら入らない呼び出しは送らずに止める。
          // 状態通知の添付 (attachDynamicContext) より前に判定する (要約の呼び出しは、 前回の本体呼び出しの並びをそのまま
          // 先頭に含める必要があるため)。
          await this.judgePendingBoundary();
          if (this._aborted) {
            // 先読みの待ちか、 規則 2 の整理 (要約の呼び出し) の途中で Esc が押された。 本体は呼ばずに止める
            console.log(chalk.yellow("\n  (処理を中断しました)"));
            this.appendAbortMarker("");
            this.recordSpanEnd("user_abort");
            return;
          }
          if (!(await this.enforceForcedLimit())) return;
          try {
            const toolDefs = this.getFilteredToolDefs();
            // 状態通知 (現在日時 / Goal / ToDo) を末尾の未送信メッセージに添付する。
            // 送信済みのメッセージは書き換えないので、 リトライで再送しても前方一致は崩れない。
            this.history.attachDynamicContext();
            // 出力上限 O (ティアの outputTokenLimit) を必ず渡す (docs/context-reduction-redesign.md §4.2 / §4.3)。
            // 役割は (1) 同じ文を繰り返し続ける生成の暴走の歯止め、 (2) 予約 R の計算 (次の呼び出しが必ず入る)。
            // contextWindow そのものは渡さない (input + max_tokens > context で 400 を返すサーバがある。
            // 例: Kimi-K2 で 13991 input + 256000 max_tokens > 262144)。 O で切れたときは finish_reason="length" になり、
            // 下の「続きを出力」 の処理が次の本体呼び出しとして続ける。
            // 呼び出しごとに AbortController を作り直す。 abort() がこれを切断することで
            // Esc 中断が HTTP 層まで届く (ストリーム待機中でも即座に reject される)。
            this.llmAbortController = new AbortController();
            const request = this.buildMainCallRequest(toolDefs, this.llmAbortController.signal);
            // 並びの指紋 (cache_miss のずれの位置と、 先読み・要約の記録との突き合わせに使う。 §10.2)
            const fingerprint = fingerprintPrompt(request.params);
            // LLM I/O ログ: リクエスト記録
            this.llmLogger.nextTurn();
            const prefixInfo = this.llmLogger.logRequest(
              this.history.getMessages(),
              this.model,
              toolDefs.length > 0 ? toolDefs : undefined,
              fingerprint,
            );
            // 送信済みの部分が変わった = プロンプトキャッシュが外れた。 忘却・圧縮など理由の分かる
            // 書き換えでなければ退行の疑いなので警告する (docs/prompt-prefix-stability.md §7)。
            const rewriteReasons = this.history.takeRewriteReasons();
            missCauses = mergeCacheMissCauses(missCauses, this.cacheMissCauses.take(rewriteReasons, this.history));
            if (this.llmLogger.logPrefixBreak(prefixInfo, rewriteReasons)) {
              logger.warn(
                `[prefix] 理由の無い書き換えで送信済みの履歴が変わりました (messages[${prefixInfo.messageOffset}] 以降、` +
                  `前回 ${prefixInfo.previousTotal} 件)。プロンプトキャッシュが外れています。`,
              );
            }
            // 次の P の土台 (送った時点の履歴の位置と書き換えの回数)。 応答の usage と組にして lastMainCall に残す
            const sentCount = this.history.getMessageCount();
            const sentRevision = this.history.getRevision();
            const gen =
              request.method === "chatWithTools"
                ? this.provider.chatWithTools(request.params)
                : this.provider.chat(request.params);

            // LLM待機スピナー: リクエスト送信〜最初のチャンク受信まで
            // 文脈情報（msg数 / 直前ターンの送信トークン / contextWindow）も併記してブラックボックス化を防ぐ
            const waitingStartTime = Date.now();
            const msgCount = this.history.getMessages().length;
            const ctxFragments: string[] = [`${msgCount}msg`];
            if (this.lastPromptTokens > 0) {
              const usedK = (this.lastPromptTokens / 1000).toFixed(1);
              const maxK =
                this.contextWindow >= 1000 ? `${Math.round(this.contextWindow / 1000)}K` : `${this.contextWindow}`;
              ctxFragments.push(`~${usedK}K/${maxK}`);
            }
            const ctxInfo = ctxFragments.join(" · ");
            let receivingStartTime = 0; // 最初のテキストチャンク受信時刻（tok/s 計算用）
            const managedStatus = screen.isAlternate();
            let waitingStatusActive = true;

            const initialWaitingStatus = chalk.dim(`  LLM処理中... (0:00 · ${ctxInfo})`);
            let waitingSpinner: ReturnType<typeof createSpinner> | null = managedStatus
              ? null
              : createSpinner({ text: initialWaitingStatus, spinner: "dots" }).start();
            if (managedStatus) screen.updateTransientStatus(initialWaitingStatus);

            // 経過時間の定期更新（1秒ごと）
            const waitingTimer = setInterval(() => {
              if (waitingStatusActive) {
                const elapsed = Math.floor((Date.now() - waitingStartTime) / 1000);
                const status = chalk.dim(`  LLM処理中... (${formatElapsed(elapsed)} · ${ctxInfo})`);
                if (managedStatus) screen.updateTransientStatus(status);
                else if (waitingSpinner) waitingSpinner.text = status;
              }
            }, 1000);

            const stopWaitingSpinner = (): void => {
              if (!waitingStatusActive) return;
              waitingStatusActive = false;
              if (waitingTimer) clearInterval(waitingTimer);
              const elapsed = Math.floor((Date.now() - waitingStartTime) / 1000);
              if (managedStatus) {
                screen.clearTransientStatus();
                if (elapsed >= 2) {
                  // 2秒以上待った場合のみ経過時間を表示
                  console.log(chalk.dim(`  LLM応答開始 (${formatElapsed(elapsed)} · ${ctxInfo})`));
                }
              } else if (waitingSpinner) {
                if (elapsed >= 2) {
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
            let thinkingStatusActive = false;
            const startThinkingSpinner = (): void => {
              if (thinkingSpinner || thinkingStatusActive) return;
              thinkingStartTime = Date.now();
              thinkingStatusActive = managedStatus;
              if (managedStatus) screen.updateTransientStatus(chalk.dim("  考え中..."));
              else thinkingSpinner = createSpinner(chalk.dim("  考え中...")).start();
              thinkingTimer = setInterval(() => {
                if (thinkingSpinner || thinkingStatusActive) {
                  const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
                  const status = chalk.dim(`  考え中... (${formatElapsed(elapsed)})`);
                  if (managedStatus) screen.updateTransientStatus(status);
                  else if (thinkingSpinner) thinkingSpinner.text = status;
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
              if (thinkingStatusActive) {
                thinkingStatusActive = false;
                screen.clearTransientStatus();
                if (failMessage !== undefined) console.log(chalk.red(`✖ ${failMessage}`));
              } else {
                screen.clearTransientStatus();
              }
            };

            for await (const chunk of abortableIterator(gen, () => this._aborted)) {
              if (process.env.LLM_DEBUG_HTTP && chunk.type === "text") {
                console.error(
                  `[LLM_DEBUG_UI] agent-loop text-chunk chars=${chunk.text?.length ?? 0} ` +
                    `streamingDisplay=${this.streamingDisplay}`,
                );
              }
              if (this._aborted) {
                stopWaitingSpinner();
                stopThinkingSpinner();
                if (this.streamingDisplay && hasStartedOutput) process.stdout.write("\n");
                console.log(chalk.yellow("\n  (処理を中断しました)"));
                // 部分テキストごと中断マーカーを履歴に残す (重複 user メッセージ蓄積の防止)
                this.appendAbortMarker(textContent);
                this.recordSpanEnd("user_abort");
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
                    if (process.env.LLM_DEBUG_HTTP) {
                      console.error("[LLM_DEBUG_UI] response-preview waiting-spinner-stopped");
                    }
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
                      if (process.env.LLM_DEBUG_HTTP) {
                        console.error("[LLM_DEBUG_UI] response-preview thinking-spinner-stopped");
                      }
                      // <think>...</think> タグをフィルタリング（古いOllamaの場合contentに含まれる）
                      const displayText = filterThinkingTags(chunk.text);
                      if (process.env.LLM_DEBUG_HTTP) {
                        console.error(`[LLM_DEBUG_UI] response-preview filtered chars=${displayText.length}`);
                      }
                      if (displayText) {
                        visibleTextContent += displayText;
                        receivedTokens += displayText.split(/\s+/).length;
                        const columns = process.stderr.columns || process.stdout.columns || 80;
                        if (!hasStartedOutput) {
                          hasStartedOutput = true;
                          receivingStartTime = Date.now();
                          const initialPreview = process.stderr.isTTY || process.stdout.isTTY ? visibleTextContent : "";
                          const initialStatus = chalk.dim(
                            formatBufferedResponseStatus(initialPreview, receivedTokens, 0, columns),
                          );
                          if (process.env.LLM_DEBUG_HTTP) {
                            console.error(
                              `[LLM_DEBUG_UI] response-preview first-chunk chars=${visibleTextContent.length} ` +
                                `stdoutTTY=${Boolean(process.stdout.isTTY)} stderrTTY=${Boolean(process.stderr.isTTY)} ` +
                                `alternate=${screen.isAlternate()} exclusive=${screen.isExclusive()}`,
                            );
                          }
                          if (managedStatus) {
                            thinkingStatusActive = true;
                            screen.updateTransientStatus(initialStatus);
                          } else {
                            thinkingSpinner = createSpinner({ text: initialStatus, spinner: "dots" }).start();
                          }
                        } else if (thinkingSpinner !== null || thinkingStatusActive) {
                          const recvElapsed = (Date.now() - receivingStartTime) / 1000;
                          const rate = recvElapsed > 0.3 ? Math.round(receivedTokens / recvElapsed) : 0;
                          const status = chalk.dim(
                            formatBufferedResponseStatus(visibleTextContent, receivedTokens, rate, columns),
                          );
                          if (managedStatus) screen.updateTransientStatus(status);
                          else if (thinkingSpinner) thinkingSpinner.text = status;
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
                    tokensCached = chunk.usage.cachedTokens;
                    const promptTokens = chunk.usage.promptTokens ?? 0;
                    const outputTokens = chunk.usage.completionTokens ?? 0;
                    const cacheRead = chunk.usage.cachedTokens ?? 0;
                    // cacheCreationTokens の有無でセマンティクスを判別 (docs/prompt-cache-cost-reduction.md):
                    //   - 定義あり = Anthropic 系。 promptTokens(=input_tokens) は cached を含まない非キャッシュ残。
                    //     読込 0.1× + 書込 1.25× で内訳計上。 表示用 inputTokens は総入力 = 非キャッシュ残+読込+書込。
                    //   - 定義なし = OpenAI 系。 promptTokens(=prompt_tokens) は cached を内包。 従来の控除計算。
                    const cacheCreation = chunk.usage.cacheCreationTokens;
                    let cost: number;
                    let recordedInput: number;
                    if (cacheCreation !== undefined) {
                      cost = globalCostCalculator.calculateForModelWithCacheBreakdown(
                        this.model,
                        promptTokens,
                        outputTokens,
                        cacheRead,
                        cacheCreation,
                      );
                      recordedInput = promptTokens + cacheRead + cacheCreation;
                    } else {
                      cost = globalCostCalculator.calculateForModelWithCache(
                        this.model,
                        promptTokens,
                        outputTokens,
                        cacheRead,
                      );
                      recordedInput = promptTokens;
                    }
                    // キャッシュが外れたかを、 前回の本体呼び出し (その後に先読みを送り終えていれば先読み) の入力と比べて判定する (§10.2)。
                    // Anthropic 系の promptTokens はキャッシュ分を含まないので、 全体 (recordedInput) で比べる。
                    const miss = diagnoseCacheMiss({
                      previous: this.lastPromptSend,
                      promptTokens: recordedInput,
                      tokensCached: chunk.usage.cachedTokens,
                      fingerprint,
                      causes: missCauses,
                    });
                    if (miss) this.llmLogger.logCacheMiss(miss);
                    this.lastPromptSend = { kind: "main", promptTokens: recordedInput, fingerprint };
                    // 依頼 1 件の増分 G の材料 (最初と最後の本体呼び出しの実数)
                    this.requestGrowth.noteMainCall(recordedInput, outputTokens);
                    this.lastMainCall = {
                      history: this.history,
                      revision: sentRevision,
                      sentCount,
                      promptTokens: recordedInput,
                      outputTokens,
                    };
                    globalTokenTracker.record({
                      timestamp: new Date().toISOString(),
                      provider: this.provider.providerType,
                      model: this.model,
                      slot: "main",
                      inputTokens: recordedInput,
                      outputTokens,
                      cachedTokens: cacheRead,
                      estimatedCostUsd: cost,
                      sessionId: this.session.meta.id,
                    });
                    // A-6: run 単位の累計 (task_complete の完了報告用)
                    this.runStats.tokensIn += recordedInput;
                    this.runStats.tokensOut += outputTokens;
                    this.runStats.costUsd += cost;
                  } else {
                    // 入力の数が分からない呼び出しを挟んだら、 その前の数とは比べない
                    this.lastPromptSend = { kind: "main", fingerprint };
                    this.lastMainCall = null;
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
              tokensCached,
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
              this.notice(
                "warn",
                `接続エラー: ${err.message} — リトライ ${connectionRetries}/${MAX_CONNECTION_RETRIES}`,
              );
              await sleep(waitMs);
              textContent = "";
              thinkingContent = "";
              toolCalls.length = 0;
              hasStartedOutput = false;
              thinkingSpinner = null;
              receivedTokens = 0;
              visibleTextContent = "";
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
            writeRuntimeError(chalk.red(`\n  エラー: ${err.message}`));
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
              visibleTextContent = "";
              thinkingStarted = false;
              continue;
            } else {
              // "abort" → この発話を中止してREPLに戻る（プロセスは終了しない）
              // _aborted を立てることで /try などの呼び出し元もループを抜けられる
              this._aborted = true;
              this.appendAbortMarker("", "LLM 呼び出しエラーにより中止");
              this.recordSpanEnd("llm_error_abort");
              return;
            }
          }
        }

        if (!success) {
          this.recordSpanEnd("llm_call_unsuccessful");
          return;
        }
        // API境界pause中のESC/Ctrl+Cはresume待ちを解放する。応答に含まれたtoolを
        // 中断後に実行しないよう、provider streamを抜けた直後に再確認する。
        if (this._aborted) {
          this.appendAbortMarker(textContent);
          this.recordSpanEnd("user_abort");
          return;
        }

        // P3-A: アシスタント応答テキストからレジスター宣言を検出 (1 user span に 1 度だけ反映)
        this.detectRegisterFromText(textContent);

        // 応答テキストの遅延表示ヘルパー (docs/spinner-mode-response-coloring-design.md v2)。
        // 構造ベース: モデルがユーザーに向けた言葉はすべて白/Markdown で表示する。
        // 「中間か最終か」 の意味分類は表示には使わない (v1 で intent classifier の誤分類により
        // 本物の回答が灰色化した事故のため廃止)。
        // 引数 final はチャネル通知用フラグのみ: span を終わらせる応答のテキスト = true。
        // assistantTextFlushed で 1 イテレーションにつき 1 回だけ表示する。
        let assistantTextFlushed = false;
        const flushAssistantText = (final: boolean): void => {
          if (assistantTextFlushed) return;
          const filteredText = createThinkingFilter()(textContent);
          if (!filteredText.trim()) return;
          assistantTextFlushed = true;
          // イベントは表示モードに依存せず発火する (チャネル購読者向け)。
          // final=true はユーザー向け最終応答として task_complete にも載せる。
          this.events.emit("assistant_text", { text: filteredText, final });
          if (final) this.runStats.finalText = filteredText;
          // CLI 表示: ストリーミングモードはライブ出力済みのためここでは表示しない
          if (this.streamingDisplay || !hasStartedOutput) return;
          if (hasMarkdown(filteredText)) {
            console.log(renderMarkdown(filteredText));
          } else {
            console.log("\n" + filteredText);
          }
        };

        // finish_reason="length": max_tokensに達して出力が途中で切れた場合、自動的に続きを生成する
        // 安全ネット: vLLMがfinish_reason="stop"を誤って返す場合に備え、
        // 構造的に不完全（未閉じコードブロック/テーブル、単語途中終端など）を検出して自動継続する
        const isTruncatedByLength = finishReason === "length" && textContent.trim().length > 0;
        const structural =
          toolCalls.length === 0 && textContent.trim().length > 0
            ? isStructurallyIncomplete(textContent)
            : { incomplete: false as const };
        if (isTruncatedByLength || structural.incomplete) {
          const structReason = "reason" in structural ? structural.reason : undefined;
          const reason = isTruncatedByLength ? "max_tokens到達" : `構造的不完全: ${structReason}`;
          // buffered modeの1行previewは一過性statusであり、確定stdoutではない。
          // 継続前に前半本文をflushしないと、後半だけが画面とterminalTranscriptに残る。
          flushAssistantText(false);
          console.log(chalk.dim(`\n  (${reason}のため、続きを生成します...)`));
          // 部分応答を一旦履歴に積んで「続き」 を促す。 部分テキストは最終回答の前半部分
          // (ユーザーに見える言葉) なので、実際に表示できた場合はdisplayedとして揮発の印を付けずに残す。
          // これを除くと履歴に残る最終回答が「続き」 の後半だけになり欠損する。
          this.history.addAssistantMessage(textContent, toolCalls.length > 0 ? toolCalls : undefined, {
            ephemeral: toolCalls.length === 0,
            thinking: thinkingContent,
            displayed: assistantTextFlushed || (this.streamingDisplay && hasStartedOutput),
          });
          this.history.addUserMessage("続きを出力してください。途中から再開してください。", { ephemeral: true });
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
          const normalized = normalizeToolCalls(textContent, this.toolRegistry.getDefinitions());
          if (normalized.toolCalls.length > 0) {
            console.log(
              chalk.dim(
                `  [tool-format] ${normalized.format} 形式から ${normalized.toolCalls.length} 件の tool 呼び出しを抽出 (tier=${this.capability.tier})`,
              ),
            );
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
            // textContent を cleanedText に差し替えるので、 直後の flushAssistantText と
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
          const normalized = normalizeToolCalls(thinkingContent, this.toolRegistry.getDefinitions());
          if (normalized.toolCalls.length > 0) {
            console.log(
              chalk.dim(
                `  [tool-format] thinking 内 ${normalized.format} 形式から ${normalized.toolCalls.length} 件の tool 呼び出しを抽出 (tier=${this.capability.tier})`,
              ),
            );
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
            // 思考欄に紛れた `</thinking>` の後ろはモデルがユーザー向けに書いた本文。 本文が空なら表示に使う
            // (例: 「原因特定！ … 修正します。」)。 docs/archive/todo-request-elaboration.md 第 2 段
            if (!textContent.trim() && normalized.visibleText) textContent = normalized.visibleText;
          }
        }

        // 空応答の再試行は「連続」回数で数える。 実のある応答 (ツール呼び出し or 本文) が出たらリセットする。
        // 旧実装は run 累計だったため、 長い作業の途中でぽつぽつ出た空応答が積み上がり、 4 回目で
        // 「連続して出力できない」 として打ち切っていた (goemon ログ: 45 ターン目、 バグ修正の呼び出しで終了)。
        if (toolCalls.length > 0 || textContent.trim().length > 0) emptyResponseRetries = 0;

        // 通常replyが終わった時点で追加入力があれば、別turnへ送らず現在のrunを継続する。
        // 途中応答はユーザーが既に見ている可能性があるためdisplayedとして保全する。
        if (toolCalls.length === 0 && this.getPendingSteeringCount() > 0) {
          flushAssistantText(false);
          if (textContent.trim() || thinkingContent.trim()) {
            this.history.addAssistantMessage(textContent, undefined, {
              ephemeral: true,
              thinking: thinkingContent,
              displayed: assistantTextFlushed || (this.streamingDisplay && hasStartedOutput),
            });
          }
          applyPendingSteering("reply");
          continue;
        }

        // ツール呼び出しを伴うテキストもユーザーへの言葉として白で表示する (v2: 構造ベース)。
        // final は構造で決める: response_complete を含む = この応答で span が終わる予定 = 最終応答。
        // ツールを伴わないテキストはここでは出さず、 下流のディスポジション地点で flush する
        // (span 継続=final:false / span 終了=final:true の判定がそこで確定するため)。
        if (toolCalls.length > 0) {
          flushAssistantText(
            toolCalls.some((tc) => tc.function.name === "response_complete") && this.getPendingSteeringCount() === 0,
          );
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
              console.log(
                chalk.yellow(
                  `  [coherence ${coherenceGateRetries}/${MAX_NEW_GATE_RETRIES}] thinking「${coherence.continuationHit}」 vs 完了「${coherence.completionHit}」 ズレ検出`,
                ),
              );
              // 元 response は履歴に積まずに (= 完了宣言を確定させず)、 nudge だけ inject して loop 続行。
              // ストリーミング表示中はユーザーが既に読んでいるため displayed で保全する。
              this.history.addAssistantMessage(textContent, undefined, {
                ephemeral: true,
                thinking: thinkingContent,
                displayed: this.streamingDisplay && hasStartedOutput,
              });
              this.history.addUserMessage(buildCoherenceNudge(coherence), { ephemeral: true });
              continue;
            }
          }
        }

        // Tool calls: execute (parallel when multiple) and continue
        if (toolCalls.length > 0) {
          hasExecutedTools = true;

          // 同じツール呼び出しの反復検出
          const currentSignature = toolCalls.map((tc) => tc.function.name + ":" + tc.function.arguments).join("|");
          for (const tc of toolCalls) windowCalls.push(`${tc.function.name}:${tc.function.arguments}`);
          if (currentSignature === lastToolSignature) {
            repeatToolCount++;
            if (repeatToolCount >= MAX_REPEAT_TOOL) {
              console.log(
                chalk.yellow(`\n  同じツール呼び出しが${MAX_REPEAT_TOOL}回連続しています。別のアプローチを試みます...`),
              );
              this.history.addAssistantMessage(textContent, toolCalls, { thinking: thinkingContent });
              // 直前のツール結果を偽造せずに、問題を指摘するメッセージを追加 (この応答の結果なので合計 T に数える)
              await this.withToolBatch(toolCalls, async (batch) => {
                for (const tc of toolCalls) {
                  this.addLimitedToolResult(
                    batch,
                    tc,
                    "Error: このツール呼び出しは同じ引数で繰り返し実行されており、同じ結果が返っています。" +
                      "別のアプローチを取ってください。ファイルが存在しない場合は作成し、ツール名を間違えている場合は正しいツールを使ってください。",
                  );
                }
                return false;
              });
              repeatToolCount = 0;
              lastToolSignature = "";
              continue;
            }
          } else {
            repeatToolCount = 1;
            lastToolSignature = currentSignature;
          }

          this.history.addAssistantMessage(textContent, toolCalls, { thinking: thinkingContent });

          const shouldAbort = await this.withToolBatch(toolCalls, (batch) =>
            toolCalls.length === 1
              ? this.executeSingleTool(toolCalls[0], batch)
              : this.executeToolsParallel(toolCalls, batch),
          );

          if (shouldAbort) {
            this.recordSpanEnd("tool_abort");
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
                } catch {
                  /* ignore */
                }
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
              } catch {
                /* ignore parse error */
              }
            } else if (toolName === "bash") {
              // bash実行 = コード検証が行われたとみなしてクリア
              pendingVerification = [];
            }
          }

          // Claude Codeと同じく、実行中に届いた通常メッセージは現在のtool群が完了して
          // tool resultが履歴へ入った直後に同じrunへ渡す。古いresponse_completeより優先する。
          if (applyPendingSteering("tool") > 0) continue;

          // response_complete が呼ばれたらターン終了（自己点検ループから明示的に抜ける）
          const rcCall = toolCalls.find((tc) => tc.function.name === "response_complete");
          if (rcCall) {
            let summary = "";
            let forceFlag = false;
            try {
              const args = JSON.parse(rcCall.function.arguments ?? "{}");
              summary = (args.summary as string) ?? "";
              forceFlag = (args.force as boolean) ?? false;
            } catch {
              /* ignore */
            }
            if (summary.length > 0) {
              // docs/spinner-mode-response-coloring-design.md v2 §2.1:
              // 本文をユーザーが既に読んでいるなら summary は重複情報 = 灰色メタ行 (両モード統一)。
              // 本文が無い場合のみ summary がユーザーへの唯一の言葉 = 白/Markdown + 最終応答に採用。
              const bodyShown = assistantTextFlushed || (this.streamingDisplay && hasStartedOutput);
              if (bodyShown) {
                console.log("\n" + chalk.dim(`  [response_complete] ${summary}`));
              } else {
                this.events.emit("assistant_text", { text: summary, final: true });
                this.runStats.finalText = summary;
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
                // 規則 2 の強い区切り (Goal の達成)。 記録して次の本体呼び出しの直前に判定する
                // (このまま依頼が終われば、 依頼の終わりの判定に含まれる)
                this.pendingBoundary = "goal-achieved";
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
            if (isStandardOrUp && !forceFlag && progressGateRetries < MAX_NEW_GATE_RETRIES) {
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
                console.log(
                  chalk.yellow(
                    `  [Q→A gate ${progressGateRetries}/${MAX_NEW_GATE_RETRIES}] stalled — ${judge.reason.slice(0, 100)}`,
                  ),
                );
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
            // progress judge中に追加入力が届いた場合も完了で取りこぼさず、同じrunを継続する。
            if (applyPendingSteering("reply") > 0) continue;
            this.recordSpanEnd("response_complete");
            return;
          }

          continue;
        }

        // ガベージ応答（トークンアーティファクト等）を検出: リプロンプトしても改善しないため中断
        // 注: 上の正規化で tool calls を抽出できた場合はここに来ない (toolCalls.length > 0)
        if (toolCalls.length === 0 && textContent.trim().length > 0 && isGarbageResponse(textContent)) {
          console.log(chalk.yellow("\n  モデルの応答が解析できない形式です。プロンプトを変えて再度お試しください。"));
          this.history.addAssistantMessage(textContent, undefined, { thinking: thinkingContent });
          this.recordSpanEnd("garbage_response");
          return;
        }

        // 検証未実施チェック: コードファイルを書いた後にbashを呼ばずにテキスト応答した場合
        if (
          toolCalls.length === 0 &&
          pendingVerification.length > 0 &&
          selfCheckRounds < MAX_SELF_CHECK_ROUNDS &&
          !this.planManager?.isInPlanMode()
        ) {
          selfCheckRounds++;
          flushAssistantText(false); // span 継続 (自己点検) — 表示は白、final ではない
          const fileList = pendingVerification.map((f) => `    - ${f}`).join("\n");
          console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] 検証未実施`));
          this.notice("info", `[自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] 検証未実施`);
          // self-check nudge は in-turn 専用 (終わった依頼の分は次の整理イベントで除く)。 thinking も保全。
          // 表示済みテキストは会話記録として保全する (displayed)。
          this.history.addAssistantMessage(textContent, undefined, {
            ephemeral: true,
            thinking: thinkingContent,
            displayed: assistantTextFlushed || (this.streamingDisplay && hasStartedOutput),
          });
          this.history.addUserMessage(
            formatSelfCheck(
              selfCheckRounds,
              MAX_SELF_CHECK_ROUNDS,
              userMessageText,
              `以下のファイルの動作確認が未完了です:\n${fileList}\n` +
                `    bash で検証コマンドを実行してください（.ts/.js: node --check, .py: python -m py_compile, プロジェクト全体: build/test/lint）。\n` +
                `    注意: GUIアプリ(pygame等)は構文チェックのみ。直接起動するとタイムアウト。`,
            ),
            { ephemeral: true },
          );
          continue;
        }
        // 検証リトライ上限到達: クリアして通常フローへ
        if (toolCalls.length === 0 && pendingVerification.length > 0 && selfCheckRounds >= MAX_SELF_CHECK_ROUNDS) {
          console.log(chalk.yellow(`\n  自己点検を${MAX_SELF_CHECK_ROUNDS}回要求しましたが完了しませんでした。`));
          pendingVerification = [];
        }

        // Evaluatorレビュー: ファイル書き込み後の完了時に自動レビュー（コード+ドキュメント両方）
        if (
          toolCalls.length === 0 &&
          pendingEvalFiles.length > 0 &&
          selfCheckRounds < MAX_SELF_CHECK_ROUNDS &&
          textContent.trim().length > 0 &&
          !this.planManager?.isInPlanMode()
        ) {
          if (!this.evaluator.isAvailable()) {
            console.log(
              chalk.yellow(
                "  Evaluatorは未実行: 独立したsecondLLMが利用できません。mainLLMによる自己評価へ自動置換しません。",
              ),
            );
            this.notice("warn", "Evaluator未実行: secondLLMを設定すると独立レビューを有効化できます");
            pendingEvalFiles = [];
          } else {
            const result = await this.evaluator.evaluate({
              filePaths: pendingEvalFiles,
              originalRequest: userMessageText,
              assistantResponse: textContent,
            });
            if (!result.passed) {
              selfCheckRounds++;
              flushAssistantText(false); // span 継続 (自己点検) — 表示は白、final ではない
              const feedback = Evaluator.formatForInjection(result);
              console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] Evaluator不合格`));
              this.notice("info", `[自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] Evaluator不合格`);
              // Evaluator 指摘は in-turn 専用、 thinking も保全。 表示済みテキストは保全 (displayed)。
              this.history.addAssistantMessage(textContent, undefined, {
                ephemeral: true,
                thinking: thinkingContent,
                displayed: assistantTextFlushed || (this.streamingDisplay && hasStartedOutput),
              });
              this.history.addUserMessage(
                formatSelfCheck(
                  selfCheckRounds,
                  MAX_SELF_CHECK_ROUNDS,
                  userMessageText,
                  `Evaluatorから以下の指摘があります:\n${feedback}`,
                ),
                { ephemeral: true },
              );
              continue;
            }
            // 合格 → クリアして通常フローへ
            pendingEvalFiles = [];
          }
        }
        // 自己点検上限到達: Evaluatorもクリアして通常フローへ
        if (pendingEvalFiles.length > 0 && selfCheckRounds >= MAX_SELF_CHECK_ROUNDS) {
          pendingEvalFiles = [];
        }

        // テキストのみ応答（ツール未呼び出し）の検出とリプロンプト
        // 会話的入力（挨拶など）では発火しない
        // ツール実行後のテキスト応答は結果報告なのでそのまま返す（再プロンプトしない）
        const shouldReprompt =
          toolCalls.length === 0 && !codeBlockRetried && !hasExecutedTools && textContent.trim().length > 0;

        let isTask = false;
        let isCompleted = false;
        if (shouldReprompt) {
          const intent = await this.intentClassifier.classifyIntent(userMessageText, this.history.getRecentContext(3));
          const completion = await this.intentClassifier.classifyCompletion(textContent);
          isTask = intent === "task";
          isCompleted = completion === "completed";
        }

        if (shouldReprompt && isTask && !isCompleted) {
          if (selfCheckRounds >= MAX_SELF_CHECK_ROUNDS) {
            // 上限到達: ユーザーに報告して中断。 ここで turn が終わる = span 終了 = final。
            flushAssistantText(true);
            console.log(
              chalk.yellow(
                `\n  自己点検を${MAX_SELF_CHECK_ROUNDS}回実施しましたが response_complete が呼ばれませんでした。`,
              ),
            );
            this.history.addAssistantMessage(textContent, undefined, { thinking: thinkingContent });
            this.recordSpanEnd("self_check_limit");
            return;
          }

          selfCheckRounds++;
          flushAssistantText(false); // span 継続 (自己点検) — 表示は白、final ではない
          console.log(chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] ツール未呼び出し`));
          this.notice("info", `[自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] ツール未呼び出し`);
          // nudge は in-turn 専用、 thinking も保全。 表示済みテキストは会話記録として保全する
          // (displayed)。 2026-06-12: 会話リクエストの実回答がこの経路で purge され、 次 span で
          // モデルが自分の回答を参照できなくなる事故があった (履歴に self-check 確認文だけが残る)。
          this.history.addAssistantMessage(textContent, undefined, {
            ephemeral: true,
            thinking: thinkingContent,
            displayed: assistantTextFlushed || (this.streamingDisplay && hasStartedOutput),
          });
          // 2026-05-01: C 案。 「promise テキストだけでは作業継続と認識しない」 を明示し、
          // 短い「了解しました」「実装します」 等の応答で止まるループを抜けやすくする。
          this.history.addUserMessage(
            formatSelfCheck(
              selfCheckRounds,
              MAX_SELF_CHECK_ROUNDS,
              userMessageText,
              `テキスト応答のみでツール呼出がありません。 ` +
                `「了解しました」「実装します」 等の promise テキストだけではハーネスは作業継続と認識しません。 ` +
                `思考 → ToDo → 実行 のリズムで進めてください: ` +
                `(a) 戦略がまだ決まっていない → \`todo_append\` で計画を 3-5 項目立てる、 ` +
                `(b) 既存 ToDo があるなら該当項目を \`todo_mark(id, "in_progress")\` してから実装 tool (file_write / file_edit / bash / mcp__...) を呼ぶ、 ` +
                `(c) 行き詰まりなら \`todo_mark(id, "blocked")\` + \`ask_user\` で相談。`,
            ),
            { ephemeral: true },
          );
          continue;
        }

        // コードブロックをテキスト返した場合のリプロンプト（file_write未使用検出）
        if (
          toolCalls.length === 0 &&
          !codeBlockRetried &&
          hasLargeCodeBlock(textContent) &&
          selfCheckRounds < MAX_SELF_CHECK_ROUNDS
        ) {
          codeBlockRetried = true;
          selfCheckRounds++;
          flushAssistantText(false); // span 継続 (自己点検) — 表示は白、final ではない
          console.log(
            chalk.dim(`  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] コードがテキスト応答に含まれています`),
          );
          this.notice(
            "info",
            `[自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] コードがテキスト応答に含まれています`,
          );
          // nudge は in-turn 専用、 thinking も保全。 表示済みテキストは保全 (displayed)。
          this.history.addAssistantMessage(textContent, undefined, {
            ephemeral: true,
            thinking: thinkingContent,
            displayed: assistantTextFlushed || (this.streamingDisplay && hasStartedOutput),
          });
          this.history.addUserMessage(
            formatSelfCheck(
              selfCheckRounds,
              MAX_SELF_CHECK_ROUNDS,
              userMessageText,
              `コードをテキストで返しましたが、実際のファイル作成には file_write ツールが必要です。` +
                `意図したパスにファイルを保存する場合は file_write を呼んでください。`,
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
            console.log(
              chalk.yellow(
                `\n  ツール呼び出しの代わりにJSONが返されました。${fakeWrites.length}件のfile_writeを直接実行します...`,
              ),
            );
            // 代わりに実行する file_write を、 この応答の呼び出しとして assistant に載せる。 結果 (tool) は必ず
            // 呼び出しを持つ assistant の直後に続ける (呼び出しの無い結果は対の検証で壊れた履歴になり、 整理できなくなる)。
            // id は応答の中で重ならないよう通し番号を付ける
            const stamp = Date.now();
            const syntheticCalls: ToolCall[] = fakeWrites.map((fw, i) => ({
              id: `synthetic_fw_${stamp}_${i}`,
              type: "function",
              function: { name: "file_write", arguments: JSON.stringify(fw) },
            }));
            this.history.addAssistantMessage(textContent, syntheticCalls, { thinking: thinkingContent });
            const shouldAbort = await this.withToolBatch(syntheticCalls, async (batch) => {
              for (let i = 0; i < syntheticCalls.length; i++) {
                if (await this.executeSingleTool(syntheticCalls[i], batch)) {
                  for (const pending of syntheticCalls.slice(i + 1)) {
                    this.addLimitedToolResult(batch, pending, "Error: 前のツールで停止したため未実行です。");
                  }
                  return true;
                }
              }
              return false;
            });
            if (shouldAbort) {
              this.recordSpanEnd("synthetic_write_abort");
              return;
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
            console.log(
              chalk.yellow(
                `\n  空のレスポンス (${reason}) — 再試行します (${emptyResponseRetries}/${MAX_EMPTY_RETRIES})...`,
              ),
            );
            // 同じリクエストをそのまま再送しても同じ結果になるため、元の意図を含むナッジメッセージを追加する。
            // 2026-05-01: 「promise だけ返す」 ループ対策として B 案を実装:
            //   ・「応答を返さないで」 等の沈黙系依頼は rephraseUserIntent で翻訳して提示
            //   ・「了解しました / 実装します 等の promise テキストだけでは作業継続と認識しない」 を明示
            const rephrasedIntent = rephraseUserIntent(userMessageText);
            const nudgeIntent = rephrasedIntent.length > 200 ? rephrasedIntent.slice(0, 200) + "..." : rephrasedIntent;
            // Phase 2: 思考保全 — thinking が出ていた場合は完全保全して placeholder にする。
            // モデルは次イテレーションで自分の前思考を読めるので、 同じ digestion を再生成
            // する無駄を避けられる。 ephemeral なので次の整理イベントで除かれる。
            //
            // 機械的な文字カット (slice) は中途半端な切り取りで意味を壊しノイズになるため避ける。
            // ctx 圧迫の懸念は以下で十分に抑えられている:
            //   - MAX_EMPTY_RETRIES=3 で span 内の積み増し回数が上限固定
            //   - 次の本体呼び出しが入らなくなれば規則 1 の整理イベントが走る
            //   - ephemeral なので次の整理イベントの前処理で除かれる
            // docs/ephemeral-context-design.md §7.1 参照。
            const placeholder =
              thinkingContent.trim().length > 0
                ? `[前回の思考 ${thinkingContent.length}字 — 形式不一致で吐き出せず、 ハーネスが保全]\n${thinkingContent}`
                : "（空のレスポンス）";
            // empty-response placeholder と nudge は in-turn 専用 (終わった依頼の分は次の整理イベントで除く)。
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
                (hasThinking ? `前回の思考は保全済み。 再思考は不要 — 結論をそのまま出力してください。\n\n` : "") +
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
          console.log(
            chalk.yellow(
              `\n  ⚠ 結果を出力できませんでした: ${reason}。\n` +
                `    考えられる原因: コンテキスト長の超過 / 出力フォーマットの乱れ。\n` +
                `    対処: もう一度依頼する / 入力を短くする / 別のモデルに切り替える。` +
                (hasThinking ? `\n    （モデルの思考内容は LLM ログに保全されています）` : ""),
            ),
          );
          this.notice("error", `結果を出力できませんでした: ${reason}`);
          // 偽の回答は履歴に入れない (捏造しない)。 honest failure は上記でユーザーに提示済み。
          this.recordSpanEnd("empty_response_giveup");
          return;
        }
        // ToDo 未完了ゲート (final_text_response 経路)。
        // docs/spinner-mode-response-coloring-design.md / docs/strategic-todo-design.md
        // response_complete は response-complete.ts で未完了 todo をブロックするが、
        // response_complete を呼ばずテキストだけで終わるこの経路にはゲートが無かった。
        // hasExecutedTools=true (このターンで実装/検証ツールを実行済み = タスク作業中) かつ
        // 未完了 todo がある場合、 自己点検 nudge を注入して「完了 or response_complete(force)」 を促す。
        // 上限到達時は未完了を明示してそのまま終了 (無限ループ防止)。
        if (hasExecutedTools && selfCheckRounds < MAX_SELF_CHECK_ROUNDS && !this.planManager?.isInPlanMode()) {
          const allTodos = getCurrentTodos();
          const openTodos = allTodos.filter((t) => t.status !== "completed");
          if (allTodos.length > 0 && openTodos.length > 0) {
            selfCheckRounds++;
            flushAssistantText(false); // span 継続 (自己点検) — 表示は白、final ではない
            console.log(
              chalk.dim(
                `  [自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] ToDo未完了 (${openTodos.length}/${allTodos.length})`,
              ),
            );
            this.notice(
              "info",
              `[自己点検 ${selfCheckRounds}/${MAX_SELF_CHECK_ROUNDS}] ToDo未完了 (${openTodos.length}/${allTodos.length})`,
            );
            this.history.addAssistantMessage(textContent, undefined, {
              ephemeral: true,
              thinking: thinkingContent,
              displayed: assistantTextFlushed || (this.streamingDisplay && hasStartedOutput),
            });
            this.history.addUserMessage(
              formatSelfCheck(
                selfCheckRounds,
                MAX_SELF_CHECK_ROUNDS,
                userMessageText,
                `Acceptance Checklist (todo) に未完了が ${openTodos.length} 項目あります:\n${formatTodosCurrent()}\n` +
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
          const openAtEnd = getCurrentTodos().filter((t) => t.status !== "completed");
          if (openAtEnd.length > 0) {
            console.log(
              chalk.yellow(`\n  ⚠ ToDo が ${openAtEnd.length} 項目未完了のまま応答を返します (自己点検上限到達)。`),
            );
          }
        }

        // ここに到達 = ツールも自己点検も無く turn が終わる = span 終了 = final。
        // intent/evaluator等の非同期gate中に届いた入力も、final確定の直前に拾う。
        if (this.getPendingSteeringCount() > 0) {
          flushAssistantText(false);
          this.history.addAssistantMessage(textContent, undefined, {
            ephemeral: true,
            thinking: thinkingContent,
            displayed: assistantTextFlushed || (this.streamingDisplay && hasStartedOutput),
          });
          applyPendingSteering("reply");
          continue;
        }
        flushAssistantText(true);
        this.history.addAssistantMessage(textContent, undefined, { thinking: thinkingContent });
        this.recordSpanEnd("final_text_response");
        return;
      }

      // ここに来るのはループ点検で止めたときだけ (for に終了条件は無い)。 黙って終わらず、
      // 何が終わり何が残ったか・なぜ止めたかを最終応答として届ける (docs/archive/todo-request-elaboration.md 第 4 段)
      const report = buildLoopStopReport(this.runStats.iterations, loopCheckInterval);
      console.log(chalk.yellow(`\n  ${report.replace(/\n/g, "\n  ")}`));
      this.events.emit("harness_notice", { level: "warn", message: "ループの疑いが続いたため作業を止めました" });
      this.history.addAssistantMessage(report);
      this.runStats.finalText = report;
      this.events.emit("assistant_text", { text: report, final: true });
      this.recordSpanEnd("max_iterations");
    } finally {
      const pauseBeforeFinish = this.runApiGate.finishRun();
      if (pauseBeforeFinish.state === "pause_requested") {
        console.log(chalk.dim("  ✓ runが次のAPIを必要とせず完了したため、一時停止の予約を終了しました。"));
      }
      this.currentRequestMessage = null;
      // task_complete は finally で必ず発火する (例外・全 return 経路を含む)。
      // outcome は recordSpanEnd() の reason マッピングで設定済み。
      // 未設定 (incomplete) のまま中断フラグが立っていれば aborted に倒す。
      if (this.runStats.outcome === "incomplete" && this._aborted) {
        this.runStats.outcome = "aborted";
      }
      // resumingは「再開後の到達点が不明になり得る」印。runが正常な終端へ到達した時だけ消す。
      // 例外・強制終了では残し、次回起動時に自動再実行をfail-fastで拒否する。
      const durableState = parseDurableRunCheckpoint(this.session.runCheckpoint);
      if (durableState.ok && durableState.checkpoint.state === "resuming" && this.runStats.outcome !== "incomplete") {
        delete this.session.runCheckpoint;
        this.saveCurrentSession();
        this.durableResumeBaseline = null;
      } else if (
        durableState.ok &&
        durableState.checkpoint.state === "resuming" &&
        this.runStats.outcome === "incomplete" &&
        this.durableResumeBaseline
      ) {
        // API/tool例外後のhistoryには、assistant tool_callだけが追加されresultが無い可能性がある。
        // 再開前のatomic状態へ戻し、次回起動でもresuming=不明状態として自動再実行を拒否する。
        this.restoreSession(structuredClone(this.durableResumeBaseline), { restoreTerminalTranscript: false });
        this.durableResumeBaseline = null;
      }
      this.events.emit("task_complete", {
        source: this.currentSource,
        outcome: this.runStats.outcome,
        finalResponse: this.runStats.finalText,
        iterations: this.runStats.iterations,
        durationMs: Date.now() - this.runStats.startMs,
        toolsExecuted: this.runStats.toolsExecuted,
        filesChanged: [...this.runStats.filesChanged],
        tokensIn: this.runStats.tokensIn,
        tokensOut: this.runStats.tokensOut,
        costUsd: this.runStats.costUsd,
      });
      // 応答の終わりでは履歴を書き換えない (docs/context-reduction-redesign.md §6.2)。 書き換えるのは規則 2 の整理イベントだけ。
      // 応答 (task_complete) を先に届け、 利用者が次を打つ前に判定する。 判定の間も処理中として扱う
      try {
        await this.finishRequest();
      } catch (e) {
        // 判定・整理は作りの上では投げない。 投げたら黙らずに知らせる (履歴は整理イベントが差し替える前なら元のまま)
        const message = `依頼の終わりのコンテキスト整理の判定に失敗しました: ${e instanceof Error ? e.message : String(e)}`;
        console.log(chalk.red(`\n  ${message}`));
        logger.error(`[reduction] ${message}`);
        this.notice("error", message);
      } finally {
        this.isProcessing = false;
      }
    }
  }

  // ─── 規則 2: 強い区切りでの先回りの整理 (docs/context-reduction-redesign.md §4.4) ───

  /**
   * run() の終わり (応答を届けた後)。 終わり方が決まった依頼は増分 G を記録し、 正常に終わった依頼は
   * 依頼の終わり (未完了の ToDo が無く、 Goal も動いていない) なら規則 2 で判定する。
   * 一時停止 (終わり方が incomplete) は同じ依頼が再開で続くので何もしない。
   */
  private async finishRequest(): Promise<void> {
    const outcome = this.runStats.outcome;
    if (outcome === "incomplete") return;
    this.requestGrowth.endRequest();
    if (outcome !== "completed") {
      // 中断・エラー・ループ停止: 次の依頼の始まりで「新しい依頼が届いた」 として判定する
      this.requestEndSettled = false;
      return;
    }
    this.requestEndSettled = true;
    const openTodos = getCurrentTodos().filter((t) => t.status === "pending" || t.status === "in_progress");
    if (openTodos.length > 0 || this.currentMode === "goal-seek") {
      // 弱い区切り (ToDo が残る応答完了) / Goal が動いている: 整理しない。
      // 記録済みの強い区切り (ToDo の全部完了など) は次の本体呼び出しの直前に判定する
      return;
    }
    // 依頼の終わり。 記録済みの強い区切りもこの判定に含まれる
    this.pendingBoundary = null;
    await this.judgeBoundary("request-end");
  }

  /** 新しい依頼が届いたとき。 前の依頼の終わりで判定していなければ判定する */
  private async judgeNewRequestBoundary(): Promise<void> {
    if (this.requestEndSettled) return;
    this.pendingBoundary = null;
    await this.judgeBoundary("new-request");
  }

  /** 記録済みの強い区切り (ToDo の全部完了・Goal の達成) を、 本体呼び出しの直前に判定する */
  private async judgePendingBoundary(): Promise<void> {
    const kind = this.pendingBoundary;
    if (kind === null) return;
    this.pendingBoundary = null;
    await this.judgeBoundary(kind);
  }

  /**
   * 規則 2: P + R + G > W なら整理イベント (boundary:<種類>) を行う。 先回りなので、 失敗しても作業は止めない
   * (失敗は整理イベントが画面と記録に出す。 次の本体呼び出しが入らなければ規則 1 が改めて判定する)。
   * 減る量の見込みが最低量 F に届かなければ、 整理イベントが書き換えずに見送る (§4.6。 次の区切りでも同じく判定する)。
   * @returns 整理イベントを行った (か見送った) なら、 その結果。 発火しなければ null
   */
  private async judgeBoundary(kind: BoundaryKind): Promise<ReductionEventResult | ReductionSkippedResult | null> {
    const budget = computeContextBudget(this.contextWindow, this.capability.tier);
    const size = this.measureNextPrompt(this.getFilteredToolDefs());
    const growth = this.requestGrowth.resolve(budget).tokens;
    if (!exceedsBoundaryLimit(size.tokens, budget, growth)) return null;
    return await this.runReductionEvent(`boundary:${kind}`, size);
  }

  /**
   * ToDo の遷移から、 全部完了 (規則 2 の強い区切り) を記録する (docs/context-reduction-redesign.md §4.4)。
   * todo-write.ts のリスナから呼ばれる。 ToDo 1 つの完了は弱い区切りなので何もしない。
   */
  private onTodoChange(before: TodoItem[], after: TodoItem[]): void {
    const allCompleted = (list: TodoItem[]): boolean => list.length > 0 && list.every((t) => t.status === "completed");
    if (allCompleted(after) && !allCompleted(before) && this.pendingBoundary === null) {
      this.pendingBoundary = "todos-complete";
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
      // A-2: 対話ブリッジがあるチャネルは CLI とほぼ同等のツールを公開し、
      // 個別の許可はブリッジ確認 (PermissionManager.checkChannelPermission) に委ねる。
      // docs/channel-interaction-bridge-design.md §5
      const bridge = getInteractionBridge(this.currentSource);
      if (bridge?.requestPermission) {
        const excluded = new Set([
          // exit_plan_mode の承認 UI が inquirer 直結 (サーバー端末でハングする)
          "enter_plan_mode",
          "exit_plan_mode",
          // サブエージェントの ToolExecutor が source を継承せず CLI 確認に流れる
          "task",
          "second_llm_agent",
        ]);
        return allDefs.filter((d) => {
          const name = d.function.name;
          if (name === "ask_user") return !!bridge.askUser;
          return !excluded.has(name);
        });
      }
      // ブリッジ無し: 従来の headless フィルタ
      const allowed = this.permissions.getAllowedToolNames(this.currentSource);
      return allDefs.filter((d) => allowed.has(d.function.name));
    }

    return allDefs;
  }

  /**
   * Phase 5 第9ラウンド (Gate 2): ユーザー直近メッセージに委任意図キーワードがあるか?
   * (「セカンドLLM」「セカンド LLM」「second llm」「サブエージェント」「委任」「頼んで」「依頼」 等)
   */
  private hasRecentDelegationIntent(): boolean {
    // raw を見る: getMessages() は状態通知 (ToDo の文言) を本文に連結するため誤検出する
    const messages = this.history.getRawMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user") {
        const content = typeof m.content === "string" ? m.content : "";
        return /セカンド\s*(?:llm|エージェント|モデル)?|second\s*llm|サブ\s*エージェント|sub.?agent|委任|頼んで|依頼/i.test(
          content,
        );
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
  private maybeTriggerDialogueLock(toolName: string, result: import("../tools/tool-registry.js").ToolResult): void {
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
    if (!result.success && toolName === "second_llm_agent" && this.hasRecentDelegationIntent()) {
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
    const reasons = this.dialogueLockReasons.length > 0 ? this.dialogueLockReasons.join(" / ") : "対話が必要な状況";
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
   * 中断された span を履歴上で可視化する assistant マーカーを積む (永続)。
   *
   * 背景 (2026-06-12): Esc 中断後、 user メッセージが「応答なし」 のまま履歴に残り、
   * ユーザーが同文を再送信するたびに同一 user メッセージが 2 重 3 重に蓄積していた。
   * モデルには区別がつかず混乱の原因になる。 silent に user メッセージを削除する案は
   * 「黙った欠損の禁止」 方針に反するため、 中断の事実を明示するマーカーで対応する。
   *
   * @param partialText 中断時点までにモデルが出力していたテキスト (あれば保全して併記)
   * @param reason マーカーに併記する理由 (省略時はユーザー中断)
   */
  private appendAbortMarker(partialText: string, reason = "ユーザーにより中断されました (Esc)"): void {
    const note = `[この応答は${reason}。 直前のユーザーメッセージへの回答は完了していません]`;
    const content = partialText.trim().length > 0 ? `${partialText}\n\n${note}` : note;
    this.history.addAssistantMessage(content);
  }

  /**
   * span 境界 (= ユーザー応答完了 / abort / 上限到達) で、 終わり方を記録する。
   *
   * 揮発メッセージ (ハーネスの自己点検・nudge・空応答 placeholder・stuck-loop 介入) と思考は、 ここでは消さない
   * (docs/context-reduction-redesign.md §6.2)。 消すと送信済みの履歴が書き換わり、 依頼 1 件ごとに KV キャッシュの全部を
   * 読み直すことになる (12〜16 万トークンで 15〜20 分)。 消すのは「借り」 として次の整理イベントの前処理 (§5.2) に回す。
   * 借りは履歴そのもの (Message.ephemeral の印と assistant.thinking) に残っているので、 別に控えは持たない。
   * 表示済みの応答テキストは、 履歴に入れるときに揮発の印を付けない (MessageHistory.addAssistantMessage)。
   *
   * @param reason ログ用の理由タグ (response_complete / user_abort / etc.)
   */
  private recordSpanEnd(reason: string): void {
    // span 終了点はほぼすべてここを通るため、 task_complete イベント用の outcome を
    // reason から決定する (docs/agent-events-design.md §3.1)。 発火自体は run() の finally。
    this.runStats.outcome = AgentLoop.SPAN_END_OUTCOMES[reason] ?? "incomplete";
  }

  // ─── 整理イベント (docs/context-reduction-redesign.md §6.1) ───

  /**
   * 本体呼び出しの送り方 (method と params) を作る。 本体呼び出しと段階 3 の要約の呼び出しが同じものを使う
   * (思考・サンプリング・ツール定義の差で前方が変わるとキャッシュが使えない。 §5.8 の申し送り)。
   * 出力上限 O (ティアの outputTokenLimit) を必ず渡す (§4.2 / §4.3)。 役割は (1) 同じ文を繰り返し続ける
   * 生成の暴走の歯止め、 (2) 予約 R の計算。 contextWindow そのものは渡さない (input + max_tokens > context で
   * 400 を返すサーバがある。 例: Kimi-K2 で 13991 input + 256000 max_tokens > 262144)。 O で切れたときは
   * finish_reason="length" になり、 「続きを出力」 の処理が次の本体呼び出しとして続ける。
   */
  private buildMainCallRequest(toolDefs: ToolDefinition[], signal: AbortSignal): MainCallRequest {
    const maxTokens = TIER_CONTEXT_BUDGETS[this.capability.tier].outputTokenLimit;
    const params = {
      model: this.model,
      messages: this.history.getMessages(),
      stream: true,
      signal,
      ...this.samplingParams,
      maxTokens,
    };
    return toolDefs.length > 0
      ? { method: "chatWithTools", params: { ...params, tools: toolDefs } }
      : { method: "chat", params };
  }

  /**
   * 次に送るプロンプトの大きさ P (§4.1)。 直前の本体呼び出しの実数 (入力の全体 + 出力) に、 その後に足したもの
   * (ツール結果・促し) の推定を足す。 間に履歴の書き換え (整理・忘却・圧縮)・載せ替えがあった、 または usage が
   * 返らなかったときは全体を推定する。 これから添付する状態通知は数えない (小さいので余白 M で吸収する)。
   */
  private measureNextPrompt(toolDefs: ToolDefinition[]): PromptSize {
    const last = this.lastMainCall;
    const raw = this.history.getRawMessages();
    const usable =
      last !== null &&
      last.history === this.history &&
      last.revision === this.history.getRevision() &&
      raw.length >= last.sentCount;
    let added: Message[] = [];
    if (usable) {
      added = raw.slice(last.sentCount);
      // 送った直後に足した assistant はその呼び出しの出力 (outputTokens で数えた)
      if (added[0]?.role === "assistant") added = added.slice(1);
    }
    return measurePromptSize({
      lastMainCall: usable ? { promptTokens: last.promptTokens, outputTokens: last.outputTokens } : null,
      addedSinceLastCall: added.map(toSentMessage),
      messages: this.history.getMessages(),
      tools: toolDefs,
    });
  }

  /**
   * 規則 1 (§4.4): 本体呼び出しの直前に P + R > W なら、 整理イベント (forced) を行う。
   * @returns 本体を呼んでよければ true。 整理に失敗した (入らない呼び出しは送らない) ・中断されたら false
   *   (終わり方の記録と履歴上の印は済ませてある)
   */
  private async enforceForcedLimit(): Promise<boolean> {
    const budget = computeContextBudget(this.contextWindow, this.capability.tier);
    const size = this.measureNextPrompt(this.getFilteredToolDefs());
    if (!exceedsForcedLimit(size.tokens, budget)) return true;
    const result = await this.runReductionEvent("forced", size);
    if (result.ok) return true;
    if (this._aborted) {
      console.log(chalk.yellow("\n  (処理を中断しました)"));
      this.appendAbortMarker("");
      this.recordSpanEnd("user_abort");
      return false;
    }
    this.appendAbortMarker("", "コンテキストの整理に失敗したため送れませんでした");
    this.recordSpanEnd("context_reduction_failed");
    return false;
  }

  /**
   * 整理イベントを 1 回行う (§6.1)。 写しに前処理・段階 0〜2 (足りなければ段階 3 の要約) を当てはめ、
   * 履歴を 1 回だけ差し替える。 失敗したら履歴は元のまま。 成功・失敗とも reduction_event を記録し、 1 行で利用者に示す。
   *
   * 呼ぶ側: 規則 1 (本体呼び出しの直前。 enforceForcedLimit)、 規則 2 (強い区切り。 judgeBoundary)、 /compact (manual。 REPL)。
   * 段階 3 の要約に失敗したときの扱いは設定 context.summaryFailure (既定 continue) に従う。
   * 要約の呼び出しの前に attachDynamicContext() を呼んでいないこと (呼び出し側の約束)。
   *
   * @param size 整理前の P。 省略時はいま測る
   */
  runReductionEvent(trigger: "forced" | "manual", size?: PromptSize): Promise<ReductionEventResult>;
  runReductionEvent(
    trigger: ReductionTrigger,
    size?: PromptSize,
  ): Promise<ReductionEventResult | ReductionSkippedResult>;
  async runReductionEvent(
    trigger: ReductionTrigger,
    size?: PromptSize,
  ): Promise<ReductionEventResult | ReductionSkippedResult> {
    const toolDefs = this.getFilteredToolDefs();
    const promptSize = size ?? this.measureNextPrompt(toolDefs);
    const budget = computeContextBudget(this.contextWindow, this.capability.tier);
    const raw = this.history.getRawMessages();
    const reducedHistory = this.history;
    const id = `r-${++this.reductionSeq}-${Date.now().toString(36)}`;
    const spinner = createSpinner("コンテキストを整理中...").start();
    // 要約の呼び出しも Esc で切れるようにする (本体呼び出しと同じ AbortController)
    this.llmAbortController = new AbortController();
    const signal = this.llmAbortController.signal;
    let result: ReductionEventResult | ReductionSkippedResult;
    try {
      result = await runReductionEvent({
        id,
        trigger,
        history: this.history,
        provider: this.provider,
        budget,
        keepRecentToolUses: TIER_CONTEXT_BUDGETS[this.capability.tier].keepRecentToolUses,
        promptSize,
        growthTokens: this.requestGrowth.resolve(budget).tokens,
        currentRequestStart: this.currentRequestStartIndex(raw),
        buildMainCallRequest: () => this.buildMainCallRequest(toolDefs, signal),
        cacheMissCauses: this.cacheMissCauses,
        growth: this.requestGrowth,
        summaryFailure: loadConfig().context?.summaryFailure ?? DEFAULT_SUMMARY_FAILURE_POLICY,
        signal,
      });
    } finally {
      this.llmAbortController = null;
    }
    if ("skipped" in result) {
      // 規則 2 の見送り (§4.6): 履歴も要約も触っていない。 画面には出さず (区切りのたびに出ると煩わしい)、
      // 動作ログと記録 (reduction_skipped) に残す。 /context の「直近の整理」 に出す。 先読みもしない (キャッシュは元のまま)
      spinner.stop();
      logger.info(`[reduction] ${triggerLabel(trigger)}: ${result.skip.detail} (${id})`);
      this.llmLogger.logReductionSkipped(result.skip);
      this.lastReduction = { history: reducedHistory, event: { skip: result.skip, finishedAt: Date.now() } };
      return result;
    }
    const line = formatReductionEventLine(result);
    if (result.ok && result.record.continuedWithoutSummary) {
      // 要約に失敗し、 設定 continue に従って段階 0〜2 の分だけで整理した。 失敗は黙らず警告として出す
      spinner.warn(line);
      logger.warn(`[reduction] ${line}`);
      this.notice("warn", line);
      this.chatLogger?.onCompressed();
    } else if (result.ok) {
      spinner.succeed(line);
      this.notice("info", line);
      this.chatLogger?.onCompressed();
    } else if (result.reason === "nothing-to-reduce" && trigger !== "forced") {
      spinner.info(line);
      this.notice("info", line);
    } else {
      spinner.fail(line);
      logger.error(`[reduction] ${line}`);
      this.notice("error", line);
    }
    // 依頼の終わり (規則 2) と /compact の整理の後は先読みする (§9.1)。 規則 1 (作業の途中) とほかの区切りは
    // すぐ本体を呼ぶので送らない。 記録 (reduction_event) は先読みの欄を埋めてから書く (送ったら終わったとき)
    const prewarmTrigger: PrewarmTrigger | null = !result.ok
      ? null
      : trigger === "boundary:request-end"
        ? "request-end"
        : trigger === "manual"
          ? "manual"
          : null;
    const last: LastReductionEvent = { record: result.record, finishedAt: Date.now(), prewarmSent: false };
    this.lastReduction = { history: reducedHistory, event: last };
    if (prewarmTrigger === null) {
      this.llmLogger.logReductionEvent(result.record);
      return result;
    }
    const prewarm = this.startPrewarm(prewarmTrigger);
    last.prewarmSent = prewarm.status === "started";
    if (prewarm.status === "skipped") {
      result.record.prewarm = prewarm.outcome;
      this.llmLogger.logReductionEvent(result.record);
    } else {
      void prewarm.done.then((outcome) => {
        result.record.prewarm = outcome;
        this.llmLogger.logReductionEvent(result.record);
      });
    }
    return result;
  }

  /**
   * 今の依頼が始まる位置 (前処理の境目。 §6.4)。 依頼の外 (待ち受け中) なら全部が終わった依頼 (raw.length)。
   * 依頼の始まりの発言が既に履歴に無い (旧方式の圧縮で要約に入った) ときは 0 (残っている全部を今の依頼とみなし、 返済しない側に倒す)
   */
  private currentRequestStartIndex(raw: readonly Message[]): number {
    if (this.currentRequestMessage === null) return raw.length;
    return Math.max(0, raw.indexOf(this.currentRequestMessage));
  }

  /** 直近の整理イベント (今の会話のもの)。 まだ無い・会話を載せ替えた・再開した後は null */
  getLastReductionEvent(): LastReductionEvent | LastReductionSkip | null {
    const last = this.lastReduction;
    return last !== null && last.history === this.history ? last.event : null;
  }

  /**
   * /context に出す整理の状態 (docs/context-reduction-redesign.md §7)。 P・R の内訳・規則 1・2 の発火点・G と直近 3 件・
   * 直近の整理イベント・今 /compact した場合の見込み (写しに段階 0〜2 を当てはめるだけ。 要約は呼ばない)。
   * 履歴は変えない。 利用者向けだけで、 モデルには見せない (§8)。
   */
  getReductionStatus(): ReductionStatus {
    const toolDefs = this.getFilteredToolDefs();
    const promptSize = this.measureNextPrompt(toolDefs);
    const budget = computeContextBudget(this.contextWindow, this.capability.tier);
    const tierBudget = TIER_CONTEXT_BUDGETS[this.capability.tier];
    const growth = this.requestGrowth.resolve(budget);
    const raw = this.history.getRawMessages();
    return {
      budget,
      keepRecentToolUses: tierBudget.keepRecentToolUses,
      toolResultLimitTokens: tierBudget.toolResultLimitTokens,
      promptSize,
      growth,
      recentGrowths: this.requestGrowth.recentGrowths(),
      forcedLimitTokens: budget.contextWindow - budget.reserveTokens,
      boundaryLimitTokens: budget.contextWindow - budget.reserveTokens - growth.tokens,
      summaryFailurePolicy: loadConfig().context?.summaryFailure ?? DEFAULT_SUMMARY_FAILURE_POLICY,
      preview: previewReduction({
        messages: raw,
        budget,
        promptSize,
        growthTokens: growth.tokens,
        keepRecentToolUses: tierBudget.keepRecentToolUses,
        currentRequestStart: this.currentRequestStartIndex(raw),
      }),
      lastEvent: this.getLastReductionEvent(),
    };
  }

  // ─── 先読み (docs/context-reduction-redesign.md §9) ───

  /**
   * 次の本体呼び出しと同じ並び (本体と同じ組み立て buildMainCallRequest。 状態通知は付けない) を、 出力上限 1 で裏で送る。
   * 送らない条件 (prewarmSkipReason) に当たれば送らず、 理由をログ (と prewarm の記録) に残す。
   * 失敗は作業を止めず、 黄色の 1 行と harness_notice (warn) で知らせる。
   */
  private startPrewarm(
    trigger: PrewarmTrigger,
  ): { status: "skipped"; outcome: PrewarmOutcome } | { status: "started"; done: Promise<PrewarmOutcome> } {
    const skip = prewarmSkipReason(this.provider.providerType, this.history.getRawMessages());
    if (skip !== null) {
      logger.info(`[prewarm] ${skip.detail}`);
      this.llmLogger.logPrewarmSkipped({ trigger, reason: skip.reason, detail: skip.detail });
      return { status: "skipped", outcome: { status: "skipped", ...skip } };
    }
    const toolDefs = this.getFilteredToolDefs();
    const done = this.prewarm
      .start(trigger, this.provider, (signal) => this.buildMainCallRequest(toolDefs, signal))
      .then((outcome) => {
        this.reportPrewarmOutcome(outcome);
        return outcome;
      });
    // /compact は結果の表示 (src/cli/commands/compact.ts) に先読みの有無を含めるので、 ここでは出さない
    if (trigger !== "manual") {
      console.log(
        chalk.dim("  先読みを送りました (次の呼び出しに備えて、 サーバに会話を読み込ませています。 結果は使いません)"),
      );
    }
    return { status: "started", done };
  }

  private reportPrewarmOutcome(outcome: PrewarmOutcome): void {
    if (outcome.status === "failed") {
      const line = `先読みに失敗しました (作業には影響しません。 次の呼び出しで会話の読み直しが起きることがあります): ${outcome.error}`;
      console.log(
        chalk.yellow(`
  ⚠ ${line}`),
      );
      logger.warn(`[prewarm] ${line}`);
      this.notice("warn", line);
    } else if (outcome.status === "aborted") {
      logger.info("[prewarm] 先読みを中断しました");
    } else if (outcome.status === "done") {
      logger.info(`[prewarm] 先読みが終わりました (${outcome.durationMs} ms)`);
    }
  }

  /**
   * セッションを再開した後の先読み (§9.1。 再開直後はサーバに今の会話が無い)。 整理イベントではないので、
   * 記録は side_call (目的 prewarm) だけ (送らなかったときは理由の記録)。 /resume・起動時の --resume・/fork の後に呼ぶ。
   * 一時停止した作業の再開 (/run resume) はすぐ本体を呼ぶので呼ばない。
   * @returns 先読みの終わり (送らなかったときはすぐ。 reject しない)
   */
  prewarmAfterResume(): Promise<PrewarmOutcome> {
    const prewarm = this.startPrewarm("resume");
    return prewarm.status === "skipped" ? Promise.resolve(prewarm.outcome) : prewarm.done;
  }

  /** 走っている先読みの終わりを待つ (表示なし。 終了処理・テスト用) */
  async waitForPrewarm(): Promise<void> {
    await this.prewarm.settled();
  }

  /** 走っている先読みを切って終わりを待つ (終了の前。 先読みの記録を書き終えるため) */
  async stopPrewarm(): Promise<void> {
    await this.prewarm.stop();
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
    circuit_break: "error",
    context_reduction_failed: "error",
    max_iterations: "max_iterations",
  };

  /**
   * P4: サーキットブレーカの中断理由を読み取り、 同時に消費 (null クリア) する。
   * メソッド戻り値は宣言型なので、 run() の「先頭で null 代入 → 別メソッドで設定」という
   * フローでも型が `null` に絞り込まれず、 cast 無しで判定できる。
   */
  private takeCircuitBreak(): { tool: string; error: string } | null {
    const cb = this._circuitBreak;
    this._circuitBreak = null;
    return cb;
  }

  /**
   * P0-A: ツール失敗を sliding window で追跡し、 同じ (signature, error) が
   * 直近 FAILURE_WINDOW 反復内に再発したら self-check メッセージを history へ注入する。
   *
   * 既存の MAX_REPEAT_TOOL=3 (連続検出) は grep/read を間に挟まれると無効化されるため、
   * これは「間に他ツールが挟まっても失敗の繰り返しを検出する」 補強。
   * docs/archive/agent-loop-efficiency-review.md §4.2 参照。
   */
  private static readonly FAILURE_WINDOW = 10;
  /** P4: 一過性失敗でも同一失敗がこの回数続いたら run を打ち切る。 恒久失敗は2回目で打ち切る。 */
  private static readonly STUCK_ABORT_THRESHOLD = 5;
  private maybeDetectStuckLoop(toolCall: ToolCall, errorMsg: string, errorKind?: "permanent" | "transient"): void {
    const iteration = this.currentIteration;
    const signature = `${toolCall.function.name}:${toolCall.function.arguments ?? ""}`;
    // window 外の古いエントリを除去
    this.recentFailures = this.recentFailures.filter((e) => iteration - e.iteration < AgentLoop.FAILURE_WINDOW);
    const trimmedErr = (errorMsg ?? "").slice(0, 500);
    const prior = this.recentFailures.filter((e) => e.signature === signature && e.error === trimmedErr);
    this.recentFailures.push({ iteration, signature, error: trimmedErr });
    if (prior.length === 0) return; // 初回失敗 → 通常通り

    const occurrences = prior.length + 1;
    // P4 (5.4): サーキットブレーカ。 恒久失敗 (401/認証/権限) は 2 回目で、 一過性でも同一失敗が
    // STUCK_ABORT_THRESHOLD 回続いたら run を打ち切る。 助言注入だけで回し続ける旧挙動を是正。
    // 恒久判定は構造化フラグ (権限拒否等は errorKind="permanent") を優先し、 無ければ外部 HTTP
    // 由来のエラー文字列ヒューリスティックで補う。
    const permanent = errorKind === "permanent" || isLikelyPermanentToolError(trimmedErr);
    if (permanent || occurrences >= AgentLoop.STUCK_ABORT_THRESHOLD) {
      this._circuitBreak = { tool: toolCall.function.name, error: trimmedErr };
      this._aborted = true; // 進行中の生成も止め、 ループ先頭の中断チェックで報告して終了する
      console.log(
        chalk.red(
          `\n  ⛔ stuck-loop 打ち切り: ${toolCall.function.name} が${permanent ? "恒久エラーで" : `${occurrences}回`}失敗。 処理を中断します。`,
        ),
      );
      this.notice(
        "error",
        `stuck-loop 打ち切り: ${toolCall.function.name} (${permanent ? "恒久失敗" : `${occurrences}回`})`,
      );
      return;
    }

    // 警告は同一signatureにつき1回に抑えるが、失敗履歴は消さない。
    // 旧実装はここで履歴を消したため、一過性失敗が停止閾値5回へ到達できなかった。
    if (this.stuckIntervenedSignatures.has(signature)) return;
    this.stuckIntervenedSignatures.add(signature);

    // 直近 window 内に同じ失敗が既にあった → 学習されていない兆候
    // Phase D-2: T3 では decision-tree mode で binary 二択を提示する。
    // 自由形式の助言は T3 にとって判断負荷が高く、 さらに迷走する原因になるため。
    const intervention =
      this.capability.tier === "T3"
        ? this.buildT3DecisionTreeIntervention(toolCall, trimmedErr, prior.length + 1)
        : this.buildStandardStuckLoopIntervention(toolCall, trimmedErr, prior.length + 1);
    console.log(
      chalk.yellow(
        `\n  ⚠ stuck-loop 検出: ${toolCall.function.name} が直近${AgentLoop.FAILURE_WINDOW}反復で同一エラー再発 (tier=${this.capability.tier})`,
      ),
    );
    this.notice("warn", `stuck-loop 検出: ${toolCall.function.name} の同一エラー再発`);
    // stuck-loop 介入は in-turn の方向修正なので揮発 (次の整理イベントで除く)。 応答の結果を全部入れた後に足す
    this.addInTurnNote(intervention);
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
  private buildBinaryDecisionOptions(toolName: string, errorMsg: string, _argumentsJson: string): [string, string] {
    if (toolName === "file_edit") {
      if (errorMsg.includes("found") && errorMsg.includes("times")) {
        return ["同じ file_edit に replace_all=true を追加して再実行", "ask_user で「どの箇所を編集するか」 を確認"];
      }
      if (errorMsg.includes("not found")) {
        return ["file_write でファイル全体を書き直す", "ask_user で「ファイルパスが正しいか」 を確認"];
      }
    }
    if (toolName === "file_read" && errorMsg.includes("not found")) {
      return [
        'glob でファイル名を検索 (例: glob({"pattern":"**/<name>"}))',
        "ask_user で「正しいファイルパス」 を確認",
      ];
    }
    if (toolName === "bash") {
      return ["コマンドの引数を変えて再実行 (例: 別コマンドや別 path)", "ask_user で「期待する動作」 を確認"];
    }
    if (toolName === "grep" || toolName === "glob") {
      return ["pattern を緩める (例: より一般的な単語、 拡張子なし)", "ask_user で「探したい内容」 を確認"];
    }
    // 汎用 fallback
    return ["ツールの引数を 1 つ変更して再実行 (エラー文の指示に従う)", "ask_user で「どう進めるか」 を確認"];
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
   * 「standard 以上」 のレジスター判定。 base harness の persistence gate
   * (Q→A 進捗 / コヒーレンス) の発火条件。 docs/strategic-todo-design.md §2.2 議論。
   */
  private isStandardOrAboveRegister(): boolean {
    const reg: string = this.currentRegister;
    return reg === "standard" || reg === "production";
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
        console.log(chalk.dim(`  [register] "${reg}" に設定`));
        return;
      }
    }
  }

  /**
   * P1-A: bash 累積時間 / P1-B: plan/todo 呼出回数を観測し、 閾値超過で 1 度だけ
   * self-check を注入する。 ツール完了直後に呼び出される。
   * docs/archive/agent-loop-efficiency-review.md §4.4 / §4.6 参照。
   */
  private static readonly BASH_CUMULATIVE_WARN_MS = 5 * 60 * 1000; // 5 分
  private static readonly PLAN_MODE_LIMIT = 2;
  private static readonly TODO_UPDATE_LIMIT = 5;
  private maybeWarnBashCumulative(toolCall: ToolCall, durationMs: number): void {
    if (toolCall.function.name !== "bash") return;
    // Phase C-3: tier で feature gating。 T3 では判断負荷増になるため抑制。
    if (!this.capability.bashCumulativeWarnEnabled) return;
    this.bashCumulativeMs += durationMs;
    if (this.bashCumulativeWarned) return;
    if (this.bashCumulativeMs < AgentLoop.BASH_CUMULATIVE_WARN_MS) return;
    const totalSec = Math.round(this.bashCumulativeMs / 1000);
    console.log(
      chalk.yellow(`\n  ⚠ bash 累積実行時間が ${totalSec}s に達しました。 重い build/run の連発を見直してください`),
    );
    // 応答の結果を全部入れた後に足す (結果の途中に挟まない)
    this.addInTurnNote(
      `[ハーネス] このユーザー発話以降、 bash の累積実行時間が ${totalSec}s を超えました。\n` +
        `  重い検証 (build / 起動 / 全件再実行) を毎 edit ごとに走らせていませんか?\n` +
        `  対策: (a) 複数 edit をまとめてから 1 回 build (b) syntax check (\`node --check\` / \`tsc --noEmit\` 等) で軽く確認 (c) ホットリロードを活用 (d) 同一コマンドの単純再実行は禁止。`,
    );
    this.bashCumulativeWarned = true;
  }
  private maybeWarnPlanTodoOveruse(toolCall: ToolCall): void {
    // Phase C-3: tier で feature gating。 T1/T3 では plan/todo 過多検知を抑制。
    // T1: 賢いLLMは自然に最小限で運用 / T3: scaffolding 増加が判断負荷を上げる
    if (!this.capability.planTodoOveruseEnabled) return;
    const name = toolCall.function.name;
    if (name === "enter_plan_mode") this.planModeEntries++;
    // 計画の書き換え (項目の追加・削除) だけを数える。 todo_mark は 1 項目ずつ状態を進める
    // 通常の使い方 (着手 → 完了) なので数えない。
    if (name === "todo_append" || name === "todo_delete") this.todoUpdateCount++;
    if (this.planTodoWarned) return;
    const planOver = this.planModeEntries > AgentLoop.PLAN_MODE_LIMIT;
    const todoOver = this.todoUpdateCount > AgentLoop.TODO_UPDATE_LIMIT;
    if (!planOver && !todoOver) return;
    const reasons: string[] = [];
    if (planOver) {
      reasons.push(
        `enter_plan_mode を ${this.planModeEntries} 回呼んでいます (上限 ${AgentLoop.PLAN_MODE_LIMIT})。 「計画蒸発」 (計画を立てて抜け、 また立てる) の兆候です。`,
      );
    }
    if (todoOver) {
      reasons.push(
        `todo_append / todo_delete を ${this.todoUpdateCount} 回呼んでいます (上限 ${AgentLoop.TODO_UPDATE_LIMIT})。 細切れの計画書き換えで反復が嵩みます。`,
      );
    }
    console.log(chalk.yellow(`\n  ⚠ 計画/Todo 過多検知: ${reasons.join(" / ")}`));
    // 応答の結果を全部入れた後に足す (結果の途中に挟むと対が切れる。 2026-10-26 実機で 397 件の応答の 6 件目の後に挟まった)
    this.addInTurnNote(
      `[ハーネス] このユーザー発話以降、 計画/Todo の更新が過多です:\n` +
        reasons.map((r) => `  - ${r}`).join("\n") +
        `\n  対策: 既存の todo を見直し、 必要なら 1 回だけ更新する。 計画モード再突入は禁止 — 既存計画を流用して実装を進めてください。`,
    );
    this.planTodoWarned = true;
  }

  /**
   * 1 回の応答のツール呼び出しの結果を入れる間の範囲。 その応答の結果は必ずこの中で addLimitedToolResult を通して入れる。
   * - 合計の上限 T を数える入れ物 (ToolResultBatch) を、 その応答の呼び出し (入れる順) で作る (docs/context-reduction-redesign.md §4.3)。
   * - 結果を入れている間にハーネスが足す促し (stuck-loop・bash 累積・計画/Todo 過多) は、 その応答の結果を全部入れた後に足す
   *   (addInTurnNote)。 結果の途中に挟むと、 呼び出しと結果の対が切れた履歴になる (2026-10-26 実機。 整理が対の検証で失敗し続けた)。
   * - 終わったとき (中断・例外を含む) に結果の無い呼び出しが残っていれば、 実行していない旨の結果を入れて対を保つ。
   * - 合計の上限で切った・省いたときは、 応答ごとに 1 行で利用者に知らせる。
   */
  private async withToolBatch(toolCalls: readonly ToolCall[], run: (batch: ToolResultBatch) => Promise<boolean>) {
    const budget = TIER_CONTEXT_BUDGETS[this.capability.tier];
    const batch = new ToolResultBatch(
      { perResultTokens: budget.toolResultLimitTokens, totalTokens: budget.toolResultTotalTokens },
      toolCalls.map((c) => c.function.name),
    );
    const scope = { filled: new Set<string>(), notes: [] as string[] };
    const outer = this.toolBatchScope;
    this.toolBatchScope = scope;
    try {
      return await run(batch);
    } finally {
      for (const call of toolCalls) {
        if (!scope.filled.has(call.id)) {
          this.addLimitedToolResult(
            batch,
            call,
            "Error: このツール呼び出しの結果を受け取れませんでした (中断または内部エラー)。",
          );
        }
      }
      this.toolBatchScope = outer;
      this.reportToolResultBatch(batch);
      for (const note of scope.notes) this.history.addUserMessage(note, { ephemeral: true });
    }
  }

  /** 応答の結果を入れている範囲 (withToolBatch)。 範囲の外では null */
  private toolBatchScope: { filled: Set<string>; notes: string[] } | null = null;

  /**
   * ハーネスの in-turn の促し (揮発の user) を足す。 ツール結果を入れている範囲の中なら、 その応答の結果を全部入れた後に足す
   * (結果の途中に挟まない)。 範囲の外ならすぐ足す。
   */
  private addInTurnNote(text: string): void {
    if (this.toolBatchScope) this.toolBatchScope.notes.push(text);
    else this.history.addUserMessage(text, { ephemeral: true });
  }

  /** 合計の上限で切った・省いた結果があれば、 応答ごとに 1 行で知らせる。 注記だけでも上限を超えたら赤字と harness_notice */
  private reportToolResultBatch(batch: ToolResultBatch): void {
    const s = batch.summary();
    if (s.overflow) {
      const message =
        `同じ応答のツール呼び出しが ${s.callCount} 件と多すぎ、 本文を省いた注記だけでも結果の合計が上限 ${s.totalTokens.toLocaleString("en-US")} トークンを超えました ` +
        `(約 ${s.usedTokens.toLocaleString("en-US")} トークン)。 次の呼び出しの前に整理が走ることがあります。`;
      console.log(chalk.red(`  ✖ ${message}`));
      this.notice("error", message);
    }
    if (s.truncatedByTotal === 0 && s.omitted.length === 0) return;
    const cut = s.truncatedByTotal > 0 ? `${s.truncatedByTotal} 件を短く切` : "";
    const omitted =
      s.omitted.length > 0
        ? `${s.omitted.length} 件は本文を省きました (${summarizeToolNames(s.omitted)}。 呼び出しは済んでおり、 成否は結果に残しています)`
        : "";
    const what = cut && omitted ? `${cut}り、 ${omitted}` : cut ? `${cut}りました` : omitted;
    const line = `  (同じ応答のツール結果の合計が上限 ${s.totalTokens.toLocaleString("en-US")} トークンに達したため、 ${what})`;
    console.log(s.omitted.length > 0 ? chalk.yellow(line) : chalk.dim(line));
  }

  /** ツール結果を上限に合わせて履歴に入れる (withToolBatch の中で呼ぶ)。 切った・省いたときは結果の中に注記が入る */
  private addLimitedToolResult(batch: ToolResultBatch, toolCall: ToolCall, content: string): void {
    const fit = batch.fit(toolCall.function.name, content);
    this.history.addToolResult(toolCall.id, fit.content);
    this.toolBatchScope?.filled.add(toolCall.id);
  }

  /** Execute a single tool call, returning whether to abort the rest of the run loop */
  private async executeSingleTool(toolCall: ToolCall, batch: ToolResultBatch): Promise<boolean> {
    if (!(await this.runApiGate.waitUntilRunning()) || this._aborted) return true;
    const summary = formatToolCall(toolCall);
    this.events.emit("tool_start", { callId: toolCall.id, name: toolCall.function.name, summary });
    const spinner = createSpinner(chalk.dim(`  ${summary}...`)).start();
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
    const needsApproval = this.permissions.getPermissionLevel(toolName) === "ask" && this.currentSource === "cli";
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
    this.trackFileChange(toolCall, result.success);
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

    let resultContent = result.success ? result.output : `Error: ${result.error}\n${result.output}`;

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

    // 1 件の上限と同じ応答の合計の上限に合わせて、 頭と尻尾を残して入れる (tool-result-limit.ts)
    this.addLimitedToolResult(batch, toolCall, resultContent);

    // P0-A: 失敗時に sliding-window で「同じ轍」 を検出して self-check 注入
    if (!result.success) {
      const errMsg = (result.error ?? result.output ?? "").toString();
      this.maybeDetectStuckLoop(toolCall, errMsg, result.errorKind);
    }
    // P1-A/B: bash 累積時間と plan/todo 過多を観測
    this.maybeWarnBashCumulative(toolCall, toolDurationMs);
    this.maybeWarnPlanTodoOveruse(toolCall);

    return result.abortExecution === true;
  }

  /** Execute multiple tool calls with concurrency limit, returning whether to abort the run loop */
  private async executeToolsParallel(toolCalls: ToolCall[], batch: ToolResultBatch): Promise<boolean> {
    if (!(await this.runApiGate.waitUntilRunning()) || this._aborted) return true;
    const limit = this.maxParallelTools;
    // 結果を履歴に入れる順 (= toolCalls の順) で合計を数えるので、 並列でも切り方は決定的
    if (limit === 1) {
      for (let i = 0; i < toolCalls.length; i++) {
        if (await this.executeSingleTool(toolCalls[i], batch)) {
          for (const pending of toolCalls.slice(i + 1)) {
            this.addLimitedToolResult(batch, pending, "Error: 前のツールで停止したため未実行です。");
          }
          return true;
        }
      }
      return false;
    }
    console.log(chalk.dim(`\n  ⟹ ${toolCalls.length} tools (max ${limit} parallel)...`));

    // セマフォによる同時実行数制限
    let running = 0;
    let batchStopped = false;
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
      if (this._aborted || batchStopped) {
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
        if (result.abortExecution) batchStopped = true;
        const durationMs = Date.now() - startMs;
        this.runStats.toolsExecuted++;
        this.trackFileChange(toolCall, result.success);
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

    for (const [index, entry] of settled.entries()) {
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
        let resultContent = result.success ? result.output : `Error: ${result.error}\n${result.output}`;

        // ID-001 §2 + §4 (2026-04-30): 段階的開示。 並列ルートでも同様にガイドを注入。
        // Phase B-3: 並列ルートでも能力ティアを渡す
        const guide = getFirstUseGuide(toolCall.function.name, this.capability.tier);
        if (guide) {
          resultContent += "\n\n" + guide;
        }

        // Phase D-3: 並列ルートでも T3 失敗時の failure few-shot を注入
        if (!result.success) {
          const failGuide = getFailureGuide(
            toolCall.function.name,
            (result.error ?? result.output ?? "").toString(),
            this.capability.tier,
          );
          if (failGuide) resultContent += "\n\n" + failGuide;
        }

        // 1 件の上限と同じ応答の合計の上限 (並列ルートも settled の順 = toolCalls の順に数える)
        this.addLimitedToolResult(batch, toolCall, resultContent);

        // P0-A: 並列ルートでも同じ sliding-window 失敗検出を適用
        if (!result.success) {
          const errMsg = (result.error ?? result.output ?? "").toString();
          this.maybeDetectStuckLoop(toolCall, errMsg, result.errorKind);
        }
        // P1-A/B: 並列ルートでも bash 累積時間 / plan/todo 過多を観測
        this.maybeWarnBashCumulative(toolCall, durationMs);
        this.maybeWarnPlanTodoOveruse(toolCall);

        if (result.abortExecution) {
          shouldAbort = true;
        }
      } else {
        // 呼び出しには必ず結果を 1 つ付ける (対を保つ)。 失敗の中身は結果と動作ログに残す
        logger.error("Parallel tool execution error:", entry.reason);
        const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
        this.addLimitedToolResult(batch, toolCalls[index], `Error: ツールの実行中に例外が発生しました: ${reason}`);
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

  /**
   * 手動の引き継ぎ + リセット (/handoff)。 整理イベントとは別の手動の機能 (docs/context-reduction-redesign.md §7)。
   * 「今ここで区切りたい」 という判断はユーザーが一番正確にできるので独立コマンドにする。
   * 引き継ぎメモの生成に失敗したら履歴には触れない。
   */
  async runHandoffNow(providedNote?: string): Promise<HandoffResult> {
    return await runHandoff(this.provider, this.model, this.history, {
      providedNote,
      saveSession: () => {
        return this.saveHandoffArchive();
      },
    });
  }

  /** 引き継ぎメモを作って返すだけ (/handoff dry)。 履歴は変更しない */
  async buildHandoffPreview(): Promise<{ note: string | null; reason?: string }> {
    return await generateHandoffNote(this.provider, this.model, this.history.getRawMessages());
  }

  private saveHandoffArchive(): string {
    this.saveCurrentSession();
    const archive = forkSession(this.session);
    archive.meta.title = `${this.session.meta.title || "会話"} (handoff archive)`;
    saveSession(archive);
    return archive.meta.id;
  }

  saveCurrentSession(): void {
    this.session.messages = this.history.getRawMessages();
    // docs/todo-goal-lifecycle.md §2.3 — in-memory slot を session JSON に保存
    this.session.todos = getTodosCurrent();
    const goal = getGoalSlot();
    this.session.goal = goal ? { definition: goal, history: getEvaluationHistory() } : null;
    // 増分 G の記録と、 まだ添えていない要約後の渡し直しは、 保存・再開をはさんでも失わない (docs/context-reduction-redesign.md §4.5 / §6.4)
    this.session.requestGrowth = this.requestGrowth.toSnapshot();
    const handover = this.history.getPendingStateHandover();
    if (handover === null) delete this.session.pendingStateHandover;
    else this.session.pendingStateHandover = handover;
    saveSession(this.session);
    logger.debug(`Session saved: ${this.session.meta.id}`);
  }

  /** 現在の会話セッション ID (resume 用)。 ~/.localllm/sessions/ 配下のファイル名と一致。 */
  getCurrentSessionId(): string {
    return this.session.meta.id;
  }

  /** 現在のsessionへ人が識別する名前を付け、atomic session保存へ即時反映する。 */
  renameCurrentSession(title: string): string {
    const normalized = normalizeSessionTitle(title);
    this.session.meta.title = normalized;
    this.saveCurrentSession();
    return normalized;
  }

  /** 現在ロード中のセッションが属する Room (未タグなら undefined)。 docs/room-model-design.md。 */
  getCurrentSessionRoom(): RoomId | undefined {
    return this.session.meta.room;
  }

  /** 現在のセッションに Room タグを付ける (RoomManager が startup/アクティブ化時に使用)。 */
  tagSessionRoom(room: RoomId): void {
    this.session.meta.room = room;
  }

  /** 現在の会話メッセージ数 (system プロンプト等を除く保存対象数)。 */
  getCurrentSessionMessageCount(): number {
    return this.history.getRawMessages().length;
  }

  /**
   * LLMプロファイル（description等）を差し替えてシステムプロンプトを再構築する。
   * REPL の /models Edit で description を変えた直後に呼ぶと、
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
      skills,
      hasSecondLLM,
      hasObsidian,
      profiles,
      this.capability.tier,
      this.currentCompressionOverrides(),
      this.safeMode,
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
    if (this.safeMode) {
      this.inputCompressionEnabled = false;
      this.compressionState = [];
      return;
    }
    this.inputCompressionEnabled = enabled;
    this.compressionState = [];

    if (!enabled) {
      // 実行時に OFF へ切替えた場合は full に戻す
      const full = buildSystemPrompt(
        this.builtSkills,
        this.builtHasSecondLLM,
        this.builtHasObsidian,
        this.llmProfiles,
        this.capability.tier,
        undefined,
        this.safeMode,
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
      this.compressionState.push({
        label: "プロジェクト指示",
        original: r.original,
        compressedText: r.applied ? r.text : undefined,
        beforeTokens: r.beforeTokens,
        afterTokens: r.afterTokens,
        applied: r.applied,
        note: r.note,
      });
    }
    if (rawMemory && rawMemory.length > limits.memory) {
      const r = await compressText(this.provider, this.model, "メモ", rawMemory);
      if (r.applied) overrides.memory = r.text;
      this.compressionState.push({
        label: "メモ",
        original: r.original,
        compressedText: r.applied ? r.text : undefined,
        beforeTokens: r.beforeTokens,
        afterTokens: r.afterTokens,
        applied: r.applied,
        note: r.note,
      });
    }

    if (overrides.projectInstructions !== undefined || overrides.memory !== undefined) {
      const compressed = buildSystemPrompt(
        this.builtSkills,
        this.builtHasSecondLLM,
        this.builtHasObsidian,
        this.llmProfiles,
        this.capability.tier,
        overrides,
        this.safeMode,
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

  restoreSession(sessionData: SessionData, options: { restoreTerminalTranscript?: boolean } = {}): void {
    // 走っている先読みの並びは古くなるので切る (再開の先読みは呼び出し側が prewarmAfterResume で改めて送る)
    this.prewarm.abort();
    this.session = sessionData;
    if (this.terminalTranscriptBridge && options.restoreTerminalTranscript !== false) {
      const restored = this.terminalTranscriptBridge.restore(sessionData.terminalTranscript, sessionData.messages);
      const mode = restored.mode;
      this.session.terminalTranscript = restored.transcript;
      if (mode === "legacy") {
        console.log("  [resume] この旧セッションには標準出力記録がないため、会話履歴から画面を再構成しました。");
      } else if (mode === "invalid") {
        console.warn(
          "  [resume] terminalTranscriptが不正なため、その記録は使用せず会話履歴から画面を再構成しました。session JSONを確認してください。",
        );
      } else if (mode === "recovered") {
        console.log(
          `  [resume] 保存stdoutで欠けていた会話本文 ${restored.recoveredMessageCount} 件をmessage履歴から復元しました。`,
        );
      }
      if (restored.transcript.truncated) {
        console.log("  [resume] 保存上限を超えた古い標準出力は省略され、保持されている末尾を復元しました。");
      }
    }
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
      this.builtSkills,
      this.builtHasSecondLLM,
      this.builtHasObsidian,
      this.llmProfiles,
      this.capability.tier,
      this.currentCompressionOverrides(),
      this.safeMode,
    );
    this.history = new MessageHistory(systemPrompt);
    // 戦略 ToDo Phase 1: 新しい MessageHistory にも composer を注入
    this.history.setSystemPromptComposer((base) => this.composeQuasiSystemPrompt(base));
    // 揮発の印と思考は「借り」 として次の整理イベントで返すので、 保存・再開で失わない (docs/context-reduction-redesign.md §6.2)。
    // 状態通知 (contextNote) も戻す: 落とすと送ったときと並びが変わり、 再開の先読みがサーバに残っている前の会話の
    // キャッシュを使えず、 全部を読み直すことになる (docs/context-reduction-redesign.md §9.4)
    for (const msg of sessionData.messages) {
      if (msg.role === "user") {
        this.history.addUserMessage(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content), {
          ephemeral: msg.ephemeral === true,
          contextNote: msg.contextNote,
        });
      } else if (msg.role === "assistant") {
        this.history.addAssistantMessage(
          typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          msg.tool_calls,
          { ephemeral: msg.ephemeral === true, thinking: msg.thinking },
        );
      } else if (msg.role === "tool") {
        this.history.addToolResult(
          msg.tool_call_id ?? "",
          typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          { contextNote: msg.contextNote },
        );
      } else if (msg.role === "system") {
        // 忘却トゥームストーン / 圧縮要約。 system prompt は session に保存されないので、
        // ここに来るのは履歴中のノートだけ
        this.history.addSystemNote(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      }
    }
    this.restoreReductionState(sessionData);
    // docs/todo-goal-lifecycle.md §2.3 — in-memory slot 復元 (旧 session は optional のためスキップ)
    if (sessionData.todos && sessionData.todos.length > 0) {
      setTodosFromGoal(sessionData.todos);
    }
    if (sessionData.goal) {
      restoreGoalState(sessionData.goal.definition, sessionData.goal.history);
    }
    // モードは goal の有無から一意に導出する (単一情報源)。 別 Room をアクティブ化した際に
    // 前 Room の currentMode が残らないよう、 goal が無ければ forward へ明示リセットする。
    this.currentMode = sessionData.goal ? "goal-seek" : "forward";
  }

  /**
   * セッションから、 整理に使う状態 (増分 G の記録・要約後の渡し直しの預かり) を戻す。 壊れていれば黙って空にせず知らせる。
   * 再開した直後は前の依頼の終わりで判定したかが分からないので、 次の依頼の始まりで規則 2 を判定する。
   */
  private restoreReductionState(sessionData: SessionData): void {
    const growth = RequestGrowthTracker.restore(sessionData.requestGrowth);
    if (growth.ok) {
      this.requestGrowth = growth.tracker;
    } else {
      this.requestGrowth = new RequestGrowthTracker();
      const message = `保存されていた依頼ごとの増分の記録を読めませんでした (${growth.error})。 記録を空にして既定値から測り直します`;
      console.warn(chalk.yellow(`  [resume] ${message}`));
      logger.warn(`[resume] ${message}`);
    }
    const handover = sessionData.pendingStateHandover;
    if (typeof handover === "string") {
      this.history.queueStateHandover(handover);
    } else if (handover !== undefined) {
      const message = "保存されていた要約後の渡し直し (pendingStateHandover) が文字列ではないため使いません";
      console.warn(chalk.yellow(`  [resume] ${message}`));
      logger.warn(`[resume] ${message}`);
    }
    this.pendingBoundary = null;
    this.requestEndSettled = false;
    // 直近の整理イベントは再開前の会話のもの (表示しない)
    this.lastReduction = null;
  }

  /**
   * A-5: 現用の会話状態への参照を取り出す (チャネル会話スワップ用)。
   * docs/archive/channel-session-queue-design.md §2
   */
  exportConversation(): ConversationState {
    const goal = getGoalSlot();
    return {
      history: this.history,
      todos: getTodosCurrent(),
      goal: goal ? { definition: goal, history: getEvaluationHistory() } : null,
      mode: this.currentMode,
      requestGrowth: this.requestGrowth,
    };
  }

  /**
   * A-5: 会話状態を載せ替える (null = 新規会話)。 キューで直列化されている前提
   * (実行中の run の最中に呼んではならない)。 todos / goal slot は module singleton
   * のためここで同期する。
   */
  importConversation(state: ConversationState | null): void {
    // 走っている先読みの並びは古くなるので切る
    this.prewarm.abort();
    if (state) {
      this.history = state.history;
      clearTodos();
      if (state.todos.length > 0) setTodosFromGoal(state.todos);
      if (state.goal) {
        restoreGoalState(state.goal.definition, state.goal.history);
      } else {
        clearGoalSlot();
      }
      this.currentMode = state.mode;
      this.requestGrowth = state.requestGrowth;
    } else {
      // 新規会話: 現在の設定でシステムプロンプトを組み直す
      const systemPrompt = buildSystemPrompt(
        this.builtSkills,
        this.builtHasSecondLLM,
        this.builtHasObsidian,
        this.llmProfiles,
        this.capability.tier,
        this.currentCompressionOverrides(),
        this.safeMode,
      );
      this.history = new MessageHistory(systemPrompt);
      this.history.setSystemPromptComposer((base) => this.composeQuasiSystemPrompt(base));
      clearTodos();
      clearGoalSlot();
      this.currentMode = "forward";
      this.requestGrowth = new RequestGrowthTracker();
    }
    // 載せ替えた会話の前の依頼の終わりで判定したかは分からないので、 次の依頼の始まりで判定する
    this.pendingBoundary = null;
    this.requestEndSettled = false;
    // chatLogger コールバックは history オブジェクトに紐づくため再適用する
    this.setChatLogger(this.chatLogger);
  }

  getHistory(): MessageHistory {
    return this.history;
  }

  getProvider(): LLMProvider {
    // run gateはmain AgentLoop専用。sub-agent/vision serviceへ渡すとforeground pauseが
    // 無関係な実行まで止めるため、共有用にはraw providerを返す。
    return this.rawProvider;
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
    todoUpdateCount: number;
    planTodoWarned: boolean;
    recentFailures: number;
    register: string;
    loopCheckInterval: number;
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
      todoUpdateCount: this.todoUpdateCount,
      planTodoWarned: this.planTodoWarned,
      recentFailures: this.recentFailures.length,
      register: this.currentRegister,
      loopCheckInterval: this.capability.loopCheckInterval,
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
      setTodosFromGoal(goal.acceptance_criteria.map((c) => ({ content: c, status: "pending" as const })));
    }
    // 準システムプロンプト composer (構築時に注入済) が次回の状態通知で goal section を含めて再合成する。
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
    // composer が次回の状態通知で goal section を含めない形で再合成する。
    logger.info(`[goal-seek] mode exited (${reason})`);
  }

  /**
   * 準システムプロンプトを毎呼出で fresh に合成する composer。
   * MessageHistory が呼ぶ (動的合成、 docs/strategic-todo-design.md §3.1)。 base は getMessages() の先頭 system、
   * Goal / ToDo は attachDynamicContext() の状態通知になる (docs/prompt-prefix-stability.md)。
   *
   * 構成:
   *   1. base: 静的 system prompt (agent identity / tool guides 等)
   *   2. Goal section: goal-seek mode かつ Goal Slot がある時のみ
   *   3. ToDo section: todos が立っている時のみ (mode を問わず常時表示 = 戦略の可視化)
   *
   * 注: register / mode 表示 は今後追加候補 (Phase 1 試験的)。 現状は省略。
   */
  private composeQuasiSystemPrompt(base: string): { stable: string; dynamic: string } {
    // dynamic は system には入らず、 MessageHistory.attachDynamicContext() が状態の変わった時だけ
    // 末尾の未送信メッセージに添付する。 現在日時もそこで付く (docs/prompt-prefix-stability.md)。
    const dynamicParts: string[] = [];
    if (this.currentMode === "goal-seek") {
      const goalSection = buildGoalSlotSection();
      if (goalSection) dynamicParts.push(goalSection);
    }
    const todoSection = buildTodoSection();
    if (todoSection) dynamicParts.push(todoSection);
    return { stable: base, dynamic: dynamicParts.join("\n\n") };
  }

  setContextWindow(value: number): void {
    // Phase A-3: ctx 窓変更でヒューリスティック判定の結果が変わり得るので再解決 (override 反映)
    const capability = resolveCapability(this.model, value, this.getCapabilityOverride(this.model));
    // 枠に入らない値なら何も変えずに止める (§6.3)
    this.assertContextWindowFits(capability, value, this.model);
    this.contextWindow = value;
    this.capability = capability;
  }

  setModel(model: string): void {
    // Phase A-3: model 切替で能力ティアを再解決 (override 反映)。 枠に入らなければ何も変えずに止める (§6.3)
    const capability = resolveCapability(model, this.contextWindow, this.getCapabilityOverride(model));
    this.assertContextWindowFits(capability, this.contextWindow, model);
    this.model = model;
    // /model <name> は provider を作り直さず model だけ即時反映する経路。
    // liveBinding を更新しないと、実際には切替済みなのに毎ターン「未反映」と誤警告する。
    if (this.liveEndpoint) {
      this.liveEndpoint = { ...this.liveEndpoint, model };
      this.liveBinding = makeLiveBinding(this.liveEndpoint, model);
    }
    // 内部コンポーネントにも伝播 (intent-classifier、 evaluator)
    this.intentClassifier.setProvider(this.provider, model);
    this.evaluator.setMainProvider(this.provider, model);
    this.capability = capability;
    logger.info(`[capability] ${formatCapabilityLabel(this.capability, model)} (${this.capability.reason})`);
  }

  /**
   * メインLLMのProviderを差し替える。/model host・/model port・/model provider 経由で
   * 接続先を実行時に変更する際に呼ぶ。modelも同時に渡せば一括反映される。
   */
  setProvider(provider: LLMProvider, model?: string, endpoint?: LLMEndpoint): void {
    // 接続先の contextWindow もここで一緒に切り替える (ollama 32K → anthropic 200K 等で古い値を残さない)。
    // 新しいモデル・枠の組で枠の検査をしてから反映し、 入らなければ何も変えずに止める (§6.3)
    const nextModel = model || this.model;
    const nextWindow =
      endpoint?.contextWindow && endpoint.contextWindow > 0 ? endpoint.contextWindow : this.contextWindow;
    // Phase A-3: provider 切替でも (model が変わる可能性あるため) capability を再解決 (override 反映)
    const capability = resolveCapability(nextModel, nextWindow, this.getCapabilityOverride(nextModel));
    this.assertContextWindowFits(capability, nextWindow, nextModel);
    this.rawProvider = provider;
    this.provider = gateLLMProvider(provider, this.runApiGate);
    this.model = nextModel;
    this.contextWindow = nextWindow;
    // 実行中バインディングを更新 (docs/model-apply-immediacy.md §3.1)。
    // endpoint を渡さない旧来の呼び出しでは前の記録を残す (= 誤警告より検出漏れを取る)。
    if (endpoint) {
      this.liveEndpoint = { ...endpoint, model: this.model };
      this.liveBinding = makeLiveBinding(this.liveEndpoint, this.model);
    }
    this.intentClassifier.setProvider(this.provider, this.model);
    this.evaluator.setMainProvider(this.provider, this.model);
    this.capability = capability;
    logger.info(`[capability] ${formatCapabilityLabel(this.capability, this.model)} (${this.capability.reason})`);
  }

  /**
   * 実行中の provider を生成したときの接続情報を記録する
   * (docs/model-apply-immediacy.md §3.1)。 起動直後は index.ts が config.mainLLM で 1 回呼ぶ。
   */
  setLiveBinding(endpoint: LLMEndpoint, model?: string): void {
    const liveModel = model ?? this.model;
    this.liveEndpoint = { ...endpoint, model: liveModel };
    this.liveBinding = makeLiveBinding(this.liveEndpoint, liveModel);
  }

  /**
   * いま動いている provider の接続情報。 未記録なら null。
   * null は「ズレ判定の材料が無い」 という意味で、 呼び出し側はズレなしとして扱う。
   */
  getLiveBinding(): LiveModelBinding | null {
    return this.liveBinding ? { ...this.liveBinding } : null;
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
   * 段階 0〜3 を最後まで行っても残る部分と予約 R が枠に入るかを確かめ、 入らなければ理由と必要量を示して止める
   * (docs/context-reduction-redesign.md §6.3)。 起動時とモデル・枠の切替時に、 反映する前に呼ぶ。
   * 固定部分はいまの system と、 登録済みのツール定義の全部 (絞り込み前。 多い方で確かめる)。
   */
  private assertContextWindowFits(capability: CapabilityProfile, contextWindow: number, modelId: string): void {
    const fit = checkContextWindowFits({
      contextWindow,
      tier: capability.tier,
      fixedTokens: this.estimateFixedTokens(),
    });
    if (!fit.ok) throw new Error(formatContextWindowTooSmall(fit, modelId, capability.tier));
  }

  /** 固定部分 = いまの system + 登録済みのツール定義の全部 (絞り込み前。 多い方で確かめる) の推定 */
  private estimateFixedTokens(): number {
    const system = this.history.getMessages()[0];
    return estimateMessageTokens([system]) + estimateToolDefinitionTokens(this.toolRegistry.getDefinitions());
  }

  /**
   * 送信時の利用者の入力の検査 (docs/context-reduction-redesign.md §4.3)。 入らなければ利用者に示す文を返す。
   * run() の最初と、 run() の前に脇の呼び出しを送る Goal 昇格の提案 (goal-promotion.ts) が使う (検査はこの 1 つだけ)。
   * 数えるのはテキスト部分だけ (画像の大きさはサーバの数え方によるので推定しない)。
   */
  checkUserInput(userMessage: string | ContentPart[]): string | null {
    const text =
      typeof userMessage === "string"
        ? userMessage
        : userMessage
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");
    const fit = checkUserInputFits({
      inputTokens: estimateTokens(text),
      contextWindow: this.contextWindow,
      tier: this.capability.tier,
      fixedTokens: this.estimateFixedTokens(),
    });
    return fit.ok ? null : formatUserInputTooLarge(fit);
  }

  /**
   * Phase A-5: config.json の modelCapabilities から override を取得。
   * fine-tune モデル等で自動判定が誤る場合のユーザ調整手段。
   * 設定不在時は undefined を返す (= 自動判定のみ)。
   */
  private getCapabilityOverride(modelId: string): import("./capability-tier.js").CapabilityOverride | undefined {
    const cfg = loadConfig();
    const overrides = cfg.modelCapabilities;
    if (!overrides) return undefined;
    // 完全一致または候補名（basename・短縮名）での一致 (lowercase 比較)
    const candidates = extractModelCandidates(modelId).map((c) => c.toLowerCase().trim());
    for (const cand of candidates) {
      for (const key of Object.keys(overrides)) {
        if (key.toLowerCase().trim() === cand) return overrides[key];
      }
    }
    return undefined;
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
    this.toolExecutor.setParallelExecutionAllowed(this.maxParallelTools > 1);
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
      `  1: リトライ (同じリクエストを再送信)\n` + `  2: 中止 (プロンプトに戻る)\n` + `選択 [1-2]: `,
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
export async function* abortableIterator<T>(gen: AsyncGenerator<T>, isAborted: () => boolean): AsyncGenerator<T> {
  const POLL_INTERVAL = 500;
  // 中断時は放置せず gen.return() で generator の finally (ストリーム cancel 等) を
  // 走らせる。 これが無いと provider 側の HTTP 接続クリーンアップが永久に実行されない。
  const cleanup = (): void => {
    void gen.return(undefined as never).catch(() => {});
  };
  // 呼び出し側が途中で抜けた時 (error チャンクでの throw / 中断の return) も中の generator を閉じる。
  // 閉じないと run gate の API 実行中カウントが戻らず、 /run pause が永久に成立しなくなる。
  let finished = false;
  try {
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
        if (result.v.done) {
          finished = true;
          return;
        }
        yield result.v.value;
        break; // 外側ループで次の gen.next() へ
      }
    }
  } finally {
    if (!finished) cleanup();
  }
}

/** コードファイル（bash検証が意味を持つファイル）かどうかを判定する */
function isCodeFile(filePath: string): boolean {
  const codeExtensions = new Set([
    ".ts",
    ".js",
    ".tsx",
    ".jsx",
    ".mts",
    ".mjs",
    ".cjs",
    ".py",
    ".rs",
    ".go",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".css",
    ".scss",
    ".html",
    ".vue",
    ".svelte",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".sql",
    ".sh",
    ".bash",
  ]);
  const ext = filePath.lastIndexOf(".") >= 0 ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  return codeExtensions.has(ext);
}

/** ドキュメントファイ���（Evaluatorレビュー対象）かどうかを判定する */
function isDocumentFile(filePath: string): boolean {
  const docExtensions = new Set([".md", ".txt", ".rst", ".adoc", ".org"]);
  const ext = filePath.lastIndexOf(".") >= 0 ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  return docExtensions.has(ext);
}
