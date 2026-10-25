/**
 * 整理イベント: コンテキスト整理を 1 回の書き換えにまとめる (docs/context-reduction-redesign.md §6.1。 整理の作り直し タスク 7)。
 *
 * 流れ:
 *   1. 履歴の写しに前処理 (借りの返済) → 段階 0 → 1 → 2 を最後まで当てはめる (reduction-stages.ts)
 *   2. まだ目標と最低量に届かなければ段階 3: 書き換え前の現在の並び + 指示で要約を得る (reduction-summary.ts)
 *   3. 写しに要約を当てはめ、 忘却の記録を 1 件にまとめて入れる (既存の記録があれば追記)
 *   4. ツールの対を検証して、 MessageHistory.replaceMessages() で 1 回だけ差し替える
 *      (書き換え理由は "reduction:<イベント ID>" の 1 件)
 *   5. cache_miss の原因に整理イベントを記録し (次の外れが expected になる)、 依頼の増分 G に減らした量を足し戻す
 *
 * 途中で失敗したら写しを捨てるだけで、 履歴は元のまま。 失敗は結果 (ok: false) として返し、 呼び出し側が利用者に見せる。
 * ただし段階 3 の要約の失敗は設定 context.summaryFailure に従う (2026-10-25 利用者の決定。 §6.1):
 *   - continue (既定): 失敗を記録と 1 行に必ず出したうえで、 段階 0〜2 の写しだけで差し替える
 *     (規則 1 で段階 0〜2 だけでは入らないときは still-too-large で止める)
 *   - stop: イベント全体を失敗にする (写しを捨てる)
 * Esc で要約が切れたとき (signal が中断済み) は設定にかかわらず失敗にする (利用者が止めた処理を続けない)。
 * 記録 (§10.1 の reduction_event) は成功・失敗のどちらでも返す。 ログへの書き込みと画面の表示は呼び出し側 (AgentLoop)。
 */
import type { SummaryFailurePolicy } from "../config/types.js";
import type { LLMProvider, Message } from "../providers/base-provider.js";
import type { CacheMissCauseCollector } from "./cache-miss.js";
import type { PrewarmOutcome } from "./prewarm.js";
import {
  type ContextBudget,
  computeReductionGoal,
  exceedsForcedLimit,
  type PromptSize,
  type RequestGrowthTracker,
} from "./context-budget.js";
import { findToolPairingError, type MessageHistory } from "./message-history.js";
import {
  applyReductionStages,
  estimateSentMessageTokens,
  insertTombstone,
  type ReductionStagesResult,
  TOMBSTONE_MARKER,
} from "./reduction-stages.js";
import {
  applySummaryToCopy,
  buildStateHandover,
  type MainCallRequest,
  requestSummary,
  type SummaryAttempt,
  type SummaryFailureReason,
  selectSummaryRange,
} from "./reduction-summary.js";

/**
 * 発火の種類 (§4.4 / §7)。 forced = 規則 1 (本体呼び出しの直前に入らない)、
 * boundary:<区切りの種類> = 規則 2 (強い区切りでの先回り)、 manual = /compact。
 */
export type ReductionTrigger = "forced" | `boundary:${BoundaryKind}` | "manual";

/**
 * 規則 2 の強い区切り (§4.4)。 request-end = 依頼の終わり (応答が正常に終わり、 未完了の ToDo が無く、 Goal も動いていない)、
 * todos-complete = ToDo が全部完了した、 goal-achieved = Goal を達成した、
 * new-request = 新しい依頼が届いた (前の依頼の終わりで判定していないときだけ)
 */
export type BoundaryKind = "request-end" | "todos-complete" | "goal-achieved" | "new-request";

export type ReductionFailureReason =
  /** 段階 0〜2 の当てはめが例外を投げた (作りの誤り) */
  | "stages-error"
  /** 要約を求めたが得られなかった (理由は summaryReason) */
  | "summary-failed"
  /** 要約の呼び出しで provider のエラー・中断が起きた */
  | "summary-error"
  /** 減らせるものが無かった (書き換えない) */
  | "nothing-to-reduce"
  /** 規則 1 の発火で、 整理しても次の本体呼び出しが入らない */
  | "still-too-large"
  /** 差し替える直前の検証・差し替えが失敗した */
  | "apply-error";

/** 段階 3 の要約の記録 (§10.1)。 tokens 系は全試行の合計 */
export interface ReductionSummaryRecord {
  status: "not-needed" | "nothing-to-summarize" | "done" | "failed" | "error";
  /** 失敗の理由 (status が failed のとき) */
  failureReason?: SummaryFailureReason;
  /** 失敗の中身 (status が failed / error のとき。 利用者に見せた文と同じ) */
  failureDetail?: string;
  segments?: number;
  attempts?: number;
  maxTokens?: number;
  tokensIn?: number;
  tokensCached?: number;
  tokensOut?: number;
  durationMs?: number;
  /** タグの外にあって捨てた文字数 */
  extraTextChars?: number;
}

/** 整理イベントの記録 (§10.1 の reduction_event)。 セッションログに 1 件ずつ書く */
export interface ReductionEventRecord {
  id: string;
  trigger: ReductionTrigger;
  ok: boolean;
  failureReason?: ReductionFailureReason;
  failureDetail?: string;
  /** 整理前の P と、 それが実数 (usage) か推定 (estimate) か */
  promptTokensBefore: number;
  promptBasis: PromptSize["basis"];
  /** 目標 (整理後の P の上限 W − R − G) と最低量 F */
  targetPromptTokens: number;
  minimumReductionTokens: number;
  /** 使った G */
  growthTokens: number;
  /** 到達した段階 (段階 0〜2 は毎回最後まで行うので 2 か 3)。 段階 0〜2 の前に失敗したら null */
  reachedStage: 2 | 3 | null;
  /** 段階ごとの減った量 (送る形の推定)。 total は差し替え前後の差 (忘却の記録の分を差し引いた実際の値) */
  freedTokens: { preprocess: number; stage0: number; stage1: number; stage2: number; stage3: number; total: number };
  /** 前処理で返した借り (終わった依頼の揮発メッセージ・思考の件数) */
  repaid: { ephemeral: number; thinking: number };
  /** 段階 0・1 で消した呼び出しの件数と、 段階 2 で消した今の依頼の思考の件数 */
  forgottenCalls: number;
  clearedCurrentThinking: number;
  /** 整理後の P の推定 (= 整理前の P − total)。 書き換えなかったときは整理前と同じ */
  promptTokensAfter: number;
  summary: ReductionSummaryRecord;
  /** 要約に失敗したときの扱い (設定 context.summaryFailure) */
  summaryFailurePolicy: SummaryFailurePolicy;
  /** 要約に失敗し、 設定 continue に従って段階 0〜2 の分だけで進めた (成功・失敗のどちらの結果にも付く) */
  continuedWithoutSummary: boolean;
  /**
   * 予熱 (§9)。 予熱する契機 (依頼の終わり・/compact) で整理に成功したときだけ、 AgentLoop が予熱の終わりに埋めてから記録する
   * (送らなかったときは理由)。 それ以外 (規則 1・ほかの区切り・失敗) は null
   */
  prewarm: PrewarmOutcome | null;
  durationMs: number;
}

export type ReductionEventResult =
  | { ok: true; record: ReductionEventRecord }
  | { ok: false; reason: ReductionFailureReason; detail: string; record: ReductionEventRecord };

export interface ReductionEventInput {
  /** イベント ID (書き換え理由 "reduction:<id>"・cache_miss の原因・記録に出る) */
  id: string;
  trigger: ReductionTrigger;
  history: MessageHistory;
  /** 段階 3 の要約を送る provider (本体と同じもの) */
  provider: LLMProvider;
  budget: ContextBudget;
  /** K (TIER_CONTEXT_BUDGETS[tier].keepRecentToolUses) */
  keepRecentToolUses: number;
  /** 整理前の P (measurePromptSize の結果) */
  promptSize: PromptSize;
  /** G (RequestGrowthTracker.resolve(budget).tokens) */
  growthTokens: number;
  /**
   * 今の依頼が始まる位置 (getRawMessages() の添字)。 これより前が終わった依頼で、 前処理の対象。
   * 依頼の外 (依頼の終わり・待ち受け中の /compact) では getRawMessages().length を渡す。
   */
  currentRequestStart: number;
  /**
   * 次の本体呼び出しと同じ送り方を作る (本体呼び出しと同じ関数。 思考・サンプリングの設定を揃えるため)。
   * 段階 3 が要るときだけ、 書き換え前に 1 回呼ぶ。 呼ぶ前に attachDynamicContext() を呼ばないこと
   * (末尾が送信済みになり、 当てはめ後の写しにも通知が残る。 通知は差し替えの後の本体呼び出しで付ける)
   */
  buildMainCallRequest: () => MainCallRequest;
  cacheMissCauses: CacheMissCauseCollector;
  growth: RequestGrowthTracker;
  /** パスの大小文字と区切りを区別しない (省略時は Windows なら true) */
  caseInsensitivePaths?: boolean;
  /** 段階 3 の要約に失敗したときの扱い (設定 context.summaryFailure。 既定は DEFAULT_SUMMARY_FAILURE_POLICY = continue) */
  summaryFailure: SummaryFailurePolicy;
  /** 要約の呼び出しを切る signal (Esc)。 中断済みなら要約の失敗を設定にかかわらず失敗にする */
  signal?: AbortSignal;
}

/** 忘却の記録 1 回分の本文 (§5.3 / §5.4 の行に、 見出しと読み直しの案内を付ける) */
export function buildReductionTombstoneText(id: string, lines: readonly string[]): string {
  return [
    `${TOMBSTONE_MARKER} 整理 ${id}: 古いツール結果などを履歴から削除しました。`,
    ...lines,
    "必要になった情報は再度ツールで取得してください。",
  ].join("\n");
}

/** 整理イベントを 1 回行う (§6.1)。 成功したときだけ履歴を 1 回差し替える */
export async function runReductionEvent(input: ReductionEventInput): Promise<ReductionEventResult> {
  const startedAt = Date.now();
  const { history, budget, promptSize } = input;
  const goal = computeReductionGoal(budget, input.growthTokens);
  const record: ReductionEventRecord = {
    id: input.id,
    trigger: input.trigger,
    ok: false,
    promptTokensBefore: promptSize.tokens,
    promptBasis: promptSize.basis,
    targetPromptTokens: goal.targetPromptTokens,
    minimumReductionTokens: goal.minimumReductionTokens,
    growthTokens: input.growthTokens,
    reachedStage: null,
    freedTokens: { preprocess: 0, stage0: 0, stage1: 0, stage2: 0, stage3: 0, total: 0 },
    repaid: { ephemeral: 0, thinking: 0 },
    forgottenCalls: 0,
    clearedCurrentThinking: 0,
    promptTokensAfter: promptSize.tokens,
    summary: { status: "not-needed" },
    summaryFailurePolicy: input.summaryFailure,
    continuedWithoutSummary: false,
    prewarm: null,
    durationMs: 0,
  };
  const fail = (reason: ReductionFailureReason, detail: string): ReductionEventResult => {
    record.ok = false;
    record.failureReason = reason;
    record.failureDetail = detail;
    record.durationMs = Date.now() - startedAt;
    return { ok: false, reason, detail, record };
  };

  // 1. 写しに前処理 + 段階 0〜2
  const raw = history.getRawMessages();
  let stages: ReductionStagesResult;
  try {
    stages = applyReductionStages({
      messages: raw,
      currentRequestStart: input.currentRequestStart,
      keepRecentToolUses: input.keepRecentToolUses,
      promptTokens: promptSize.tokens,
      goal,
      caseInsensitivePaths: input.caseInsensitivePaths,
    });
  } catch (e) {
    return fail("stages-error", e instanceof Error ? e.message : String(e));
  }
  record.reachedStage = 2;
  record.freedTokens = { ...stages.freedTokens, stage3: 0 };
  record.repaid = { ...stages.repaid };
  record.forgottenCalls = stages.forgotten.length;
  record.clearedCurrentThinking = stages.clearedCurrentThinking;

  let next: Message[] = stages.messages;
  let tombstoneAt = stages.firstForgottenIndex;
  let handover: string | null = null;
  /** 要約に失敗して段階 0〜2 だけで進めるときの、 失敗の中身 (後の失敗の文にも添える) */
  let summaryFailureNote: string | null = null;
  const continueAfterSummaryFailure = (): boolean =>
    input.summaryFailure === "continue" && input.signal?.aborted !== true;

  // 2〜3. 足りなければ段階 3 (書き換え前の並び + 指示で要約を得て、 写しに当てはめる)
  if (stages.needsSummary) {
    const rangeResult = selectSummaryRange({
      messages: stages.messages,
      originalIndices: stages.originalIndices,
      originalLength: raw.length,
      keepRecentToolUses: input.keepRecentToolUses,
      shortfall: stages.shortfall,
    });
    if (!rangeResult.ok) {
      // 要約しても減らない (要約してよい範囲が小さい)。 段階 0〜2 の分だけで進める。
      // 規則 1 で入らないなら下の検査で失敗にする
      record.summary = { status: rangeResult.reason === "not-needed" ? "not-needed" : "nothing-to-summarize" };
    } else {
      const range = rangeResult.range;
      record.reachedStage = 3;
      let summaryResult: Awaited<ReturnType<typeof requestSummary>> | null;
      try {
        summaryResult = await requestSummary({
          provider: input.provider,
          request: input.buildMainCallRequest(),
          history: raw,
          range,
          promptTokens: promptSize.tokens,
          budget,
        });
      } catch (e) {
        const detail = `要約の呼び出しが失敗しました: ${e instanceof Error ? e.message : String(e)}`;
        record.summary = { status: "error", segments: range.segments.length, failureDetail: detail };
        if (!continueAfterSummaryFailure()) return fail("summary-error", detail);
        summaryResult = null;
        summaryFailureNote = detail;
      }
      if (summaryResult !== null) {
        record.summary = {
          status: summaryResult.ok ? "done" : "failed",
          failureReason: summaryResult.ok ? undefined : summaryResult.reason,
          failureDetail: summaryResult.ok
            ? undefined
            : `要約を得られませんでした (${summaryResult.reason}): ${summaryResult.detail}`,
          segments: range.segments.length,
          attempts: summaryResult.attempts.length,
          maxTokens: summaryResult.maxTokens,
          ...sumUsage(summaryResult.attempts),
          durationMs: summaryResult.durationMs,
          extraTextChars: summaryResult.ok ? summaryResult.summary.extraTextChars : undefined,
        };
        if (!summaryResult.ok) {
          const detail = record.summary.failureDetail ?? "要約を得られませんでした";
          if (!continueAfterSummaryFailure()) return fail("summary-failed", detail);
          summaryFailureNote = detail;
        }
      }
      if (summaryFailureNote !== null) {
        // 設定 continue: 要約は使わず、 段階 0〜2 の写しのまま進める (失敗は記録と 1 行に出す)
        record.continuedWithoutSummary = true;
      } else if (summaryResult?.ok) {
        try {
          const applied = applySummaryToCopy(stages.messages, range, summaryResult.summary);
          next = applied.messages;
          record.freedTokens.stage3 = applied.freedTokens;
          if (tombstoneAt !== null) {
            tombstoneAt = tombstoneAt < applied.newIndexOf.length ? applied.newIndexOf[tombstoneAt] : next.length;
          }
        } catch (e) {
          return fail("apply-error", e instanceof Error ? e.message : String(e));
        }
        handover = buildStateHandover(raw, range, summaryResult.summary, input.caseInsensitivePaths);
      }
    }
  }

  // 4. 忘却の記録を 1 件にまとめて入れる (既存の記録があれば追記)
  if (stages.recordLines.length > 0) {
    next = insertTombstone(next, buildReductionTombstoneText(input.id, stages.recordLines), tombstoneAt ?? next.length);
  }

  const total = estimateSentMessageTokens(raw) - estimateSentMessageTokens(next);
  record.freedTokens.total = total;
  const summaryNote = summaryFailureNote === null ? "" : `。 ${summaryFailureNote}`;
  if (total <= 0) {
    return fail(
      "nothing-to-reduce",
      `減らせるものがありませんでした (段階 0〜2 で ${stages.freedTokens.total.toLocaleString("en-US")} トークン、 要約: ${record.summary.status}${summaryNote})`,
    );
  }
  const promptTokensAfter = promptSize.tokens - total;
  if (input.trigger === "forced" && exceedsForcedLimit(promptTokensAfter, budget)) {
    const n = (v: number) => v.toLocaleString("en-US");
    return fail(
      "still-too-large",
      `整理しても次の呼び出しが入りません (整理後の推定 P ${n(promptTokensAfter)} + 予約 R ${n(budget.reserveTokens)} > ` +
        `contextWindow ${n(budget.contextWindow)}。 要約: ${record.summary.status}${summaryNote})`,
    );
  }

  // 5. 検証して 1 回だけ差し替える
  const pairingError = findToolPairingError(next);
  if (pairingError) return fail("apply-error", `差し替え前の写しのツールの対が壊れています: ${pairingError}`);
  try {
    history.replaceMessages(next, `reduction:${input.id}`);
  } catch (e) {
    return fail("apply-error", e instanceof Error ? e.message : String(e));
  }
  input.cacheMissCauses.noteReductionEvent(input.id);
  input.growth.noteReduction(total);
  if (handover !== null) history.queueStateHandover(handover);

  record.ok = true;
  record.promptTokensAfter = promptTokensAfter;
  record.durationMs = Date.now() - startedAt;
  return { ok: true, record };
}

function sumUsage(
  attempts: readonly SummaryAttempt[],
): Pick<ReductionSummaryRecord, "tokensIn" | "tokensCached" | "tokensOut"> {
  const withUsage = attempts.filter((a) => a.usage);
  if (withUsage.length === 0) return {};
  const cached = withUsage.filter((a) => a.usage?.cachedTokens !== undefined);
  return {
    tokensIn: withUsage.reduce((s, a) => s + (a.usage?.promptTokens ?? 0), 0),
    tokensCached: cached.length > 0 ? cached.reduce((s, a) => s + (a.usage?.cachedTokens ?? 0), 0) : undefined,
    tokensOut: withUsage.reduce((s, a) => s + (a.usage?.completionTokens ?? 0), 0),
  };
}

/** 利用者向けの 1 行 (成功・失敗) */
export function formatReductionEventLine(result: ReductionEventResult): string {
  const r = result.record;
  const n = (v: number) => v.toLocaleString("en-US");
  const label = triggerLabel(r.trigger);
  if (!result.ok) {
    return `コンテキストの整理 (${label}) に失敗しました。 履歴は変えていません: ${result.detail}`;
  }
  if (r.continuedWithoutSummary) {
    // 要約の失敗は黙らない: 段階 0〜2 の分だけで進めたことと、 失敗の中身を同じ行に出す
    return (
      `コンテキストを整理しました (${label}) が、 要約に失敗したため段階 0〜2 の分だけです: 約 ${n(r.freedTokens.total)} トークン減。 ` +
      `推定 ${n(r.promptTokensBefore)} → ${n(r.promptTokensAfter)} トークン (${r.id})。 ${r.summary.failureDetail ?? "要約の失敗"}`
    );
  }
  const parts = [`約 ${n(r.freedTokens.total)} トークン減`];
  if (r.summary.status === "done") parts.push(`要約 ${r.summary.segments} 区間`);
  if (r.repaid.ephemeral + r.repaid.thinking > 0) {
    parts.push(`前の依頼の補助メッセージ ${r.repaid.ephemeral} 件・思考 ${r.repaid.thinking} 件を削除`);
  }
  return (
    `コンテキストを整理しました (${label}): ${parts.join("、 ")}。 ` +
    `推定 ${n(r.promptTokensBefore)} → ${n(r.promptTokensAfter)} トークン (${r.id})`
  );
}

/** 発火の種類の、 利用者向けの言い方 */
export function triggerLabel(trigger: ReductionTrigger): string {
  switch (trigger) {
    case "forced":
      return "次の呼び出しが入らないため";
    case "manual":
      return "手動";
    case "boundary:request-end":
      return "依頼の区切り";
    case "boundary:todos-complete":
      return "ToDo が全部完了";
    case "boundary:goal-achieved":
      return "Goal を達成";
    case "boundary:new-request":
      return "新しい依頼の前";
    default: {
      const exhaustive: never = trigger;
      return String(exhaustive);
    }
  }
}
