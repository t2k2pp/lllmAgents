/**
 * 整理イベント: コンテキスト整理を 1 回の書き換えにまとめる (docs/context-reduction-redesign.md §6.1。 整理の作り直し タスク 7)。
 *
 * 流れ:
 *   1. 履歴の写しに前処理 (借りの返済) → 段階 0 → 1 → 2 を最後まで当てはめる (reduction-stages.ts)
 *   2. まだ目標と最低量に届かなければ段階 3: 書き換え前の現在の並び + 指示で要約を得る (reduction-summary.ts)。
 *      手動の /compact は届いていても、 要約してよい最大の範囲を要約する (段階 0〜3 を最後まで。 §7)
 *   3. 写しに要約を当てはめ、 忘却の記録を 1 件にまとめて入れる (既存の記録があれば追記)
 *   4. ツールの対を検証して、 MessageHistory.replaceMessages() で 1 回だけ差し替える
 *      (書き換え理由は "reduction:<イベント ID>" の 1 件)
 *   5. cache_miss の原因に整理イベントを記録し (次の外れが expected になる)、 依頼の増分 G に減らした量を足し戻す
 *
 * 規則 2 (boundary:*) は、 段階 0〜2 の見込み (要るなら段階 3 の範囲の見込みも足す) が最低量 F に届くときだけ行う (§4.6。
 * Anthropic の clear_at_least と同じ考え方)。 届かなければ要約を呼ばず、 履歴も書き換えずに見送り、 見送りの記録 (reduction_skipped) を返す。
 * 規則 1 (forced) と手動の /compact は見送らない。
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
  type ReductionGoal,
  type RequestGrowth,
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
  type SummaryRangeResult,
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
 * new-request = 新しい依頼が届いた (前の依頼の終わりで判定していないときだけ)、
 * before-prewarm = 先読みの前 (再開の後の自動の先読み・/prewarm。 送る前に、 次の依頼の始まりと同じ判定をする。 §9.4)
 */
export type BoundaryKind = "request-end" | "todos-complete" | "goal-achieved" | "new-request" | "before-prewarm";

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
   * 先読み (§9)。 先読みする契機 (依頼の終わり・/compact) で整理に成功したときだけ、 AgentLoop が先読みの終わりに埋めてから記録する
   * (送らなかったときは理由)。 それ以外 (規則 1・ほかの区切り・失敗) は null
   */
  prewarm: PrewarmOutcome | null;
  durationMs: number;
}

export type ReductionEventResult =
  | { ok: true; record: ReductionEventRecord }
  | { ok: false; reason: ReductionFailureReason; detail: string; record: ReductionEventRecord };

/**
 * 規則 2 の見送りの記録 (§4.6。 セッションログの reduction_skipped)。 見込みの減る量が最低量 F に届かないので、
 * 要約を呼ばず、 履歴も書き換えなかった。 失敗ではない (書き換えが割に合わないだけ。 入らなくなれば規則 1 が整理する)
 */
export interface ReductionSkipRecord {
  /** 整理イベントと同じ形の ID (見送りも通し番号を進める。 /context の「直近の整理」 に出る) */
  id: string;
  trigger: BoundaryTrigger;
  /** below-minimum = 見込みが最低量 F に届かない */
  reason: "below-minimum";
  /** 利用者向けの説明 (動作ログと /context に出す) */
  detail: string;
  promptTokensBefore: number;
  promptBasis: PromptSize["basis"];
  targetPromptTokens: number;
  minimumReductionTokens: number;
  growthTokens: number;
  /**
   * 見込みの減る量 (送る形の推定)。 stages = 前処理と段階 0〜2、 summary = 段階 3 の範囲の見込み
   * (要約が要らない・要約してよい範囲が無ければ null)、 total = 合計
   */
  expectedFreedTokens: { stages: number; summary: number | null; total: number };
  /** 段階 3 の見込み: nothing-to-summarize = 要約してよい範囲が無い、 insufficient = 範囲を要約しても F に届かない */
  summary: { status: "nothing-to-summarize" } | { status: "insufficient"; segments: number };
  durationMs: number;
}

/** 規則 2 を見送ったときの結果 (履歴は元のまま。 要約も呼んでいない) */
export interface ReductionSkippedResult {
  ok: false;
  skipped: true;
  skip: ReductionSkipRecord;
}

/** 規則 2 の発火の種類 */
export type BoundaryTrigger = `boundary:${BoundaryKind}`;

/** 規則 2 (強い区切りでの先回り) の発火か */
export function isBoundaryTrigger(trigger: ReductionTrigger): trigger is BoundaryTrigger {
  return trigger.startsWith("boundary:");
}

/** 減る量の見込みが最低量 F に届くか (§4.6)。 規則 2 の「行うか見送るか」 と /context の見込みが同じものを使う */
export interface ReductionWorth {
  /** 見込みが F に届く (行う) */
  worthIt: boolean;
  /** 行うとき、 段階 3 の要約を呼ぶか (段階 0〜2 の後も目標か F に届かず、 要約してよい範囲がある) */
  withSummary: boolean;
  expectedFreedTokens: ReductionSkipRecord["expectedFreedTokens"];
}

/**
 * 段階 0〜2 の結果と段階 3 の範囲 (規則 1・2 の決め方。 selectStage3Range) から、 減る量の見込みが F に届くかを決める。
 * 要約は呼ばない (呼ぶ前に決める)。 段階 0〜2 だけで F に届けば行う (目標に届かなければ、 これまでどおり要約もする)。
 * 届かなければ、 要約の範囲の見込みを足して F に届くときだけ要約まで行う。 それでも届かなければ見送る。
 */
export function assessReductionWorth(
  stages: ReductionStagesResult,
  range: SummaryRangeResult | null,
  goal: ReductionGoal,
): ReductionWorth {
  const fromStages = stages.freedTokens.total;
  const fromSummary = range?.ok === true ? range.range.estimatedFreedTokens : null;
  const total = fromStages + (fromSummary ?? 0);
  return {
    worthIt: total >= goal.minimumReductionTokens,
    withSummary: fromSummary !== null,
    expectedFreedTokens: { stages: fromStages, summary: fromSummary, total },
  };
}

/** 見送りの説明 (動作ログ・/context) */
function skipDetail(worth: ReductionWorth, goal: ReductionGoal): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const e = worth.expectedFreedTokens;
  const summary =
    e.summary === null ? "要約してよい範囲はありません" : `要約で 約 ${n(e.summary)} (要約は呼んでいません)`;
  return (
    `減る量の見込みが最低量 ${n(goal.minimumReductionTokens)} に届かないため、 履歴を書き換えずに見送りました ` +
    `(見込み 約 ${n(e.total)} = 段階 0〜2 で 約 ${n(e.stages)}、 ${summary})`
  );
}

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
  /**
   * 履歴を書き換えると決めたときに 1 回呼ぶ (§9.5)。 規則 1・手動は始まりに、 規則 2 は見込みが最低量 F に届くと決めた直後
   * (要約の呼び出しと差し替えより前) に呼ぶ。 規則 2 の見送りでは呼ばない。 AgentLoop はここで走っている先読みを切る
   * (書き換えた後の並びは先読みの並びで始まらないので、 先読みを待つのも、 サーバに計算させ続けるのも無駄)
   */
  onWillRewrite?: () => void;
}

/** 忘却の記録 1 回分の本文 (§5.3 / §5.4 の行に、 見出しと読み直しの案内を付ける) */
export function buildReductionTombstoneText(id: string, lines: readonly string[]): string {
  return [
    `${TOMBSTONE_MARKER} 整理 ${id}: 古いツール結果などを履歴から削除しました。`,
    ...lines,
    "必要になった情報は再度ツールで取得してください。",
  ].join("\n");
}

/**
 * 整理イベントを 1 回行う (§6.1)。 成功したときだけ履歴を 1 回差し替える。
 * 規則 2 (boundary:*) は見込みが最低量 F に届かなければ見送る (ReductionSkippedResult。 §4.6)。 規則 1・手動は見送らない
 */
export function runReductionEvent(
  input: ReductionEventInput & { trigger: "forced" | "manual" },
): Promise<ReductionEventResult>;
export function runReductionEvent(input: ReductionEventInput): Promise<ReductionEventResult | ReductionSkippedResult>;
export async function runReductionEvent(
  input: ReductionEventInput,
): Promise<ReductionEventResult | ReductionSkippedResult> {
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

  // 規則 1・手動は見送らないので、 始まりで書き換えると決まる (規則 2 は下で見込みを確かめてから)
  if (!isBoundaryTrigger(input.trigger)) input.onWillRewrite?.();

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

  // 2〜3. 足りなければ (手動の /compact なら必ず) 段階 3 (書き換え前の並び + 指示で要約を得て、 写しに当てはめる)
  const rangeResult = selectStage3Range(input.trigger, stages, raw.length, input.keepRecentToolUses);
  const boundary = isBoundaryTrigger(input.trigger);
  if (isBoundaryTrigger(input.trigger)) {
    // 規則 2: 要約を呼ぶ前に、 見込みが最低量 F に届くかを決める。 届かなければ書き換えずに見送る (§4.6)
    const worth = assessReductionWorth(stages, rangeResult, goal);
    if (!worth.worthIt) {
      return {
        ok: false,
        skipped: true,
        skip: {
          id: input.id,
          trigger: input.trigger,
          reason: "below-minimum",
          detail: skipDetail(worth, goal),
          promptTokensBefore: promptSize.tokens,
          promptBasis: promptSize.basis,
          targetPromptTokens: goal.targetPromptTokens,
          minimumReductionTokens: goal.minimumReductionTokens,
          growthTokens: input.growthTokens,
          expectedFreedTokens: worth.expectedFreedTokens,
          summary:
            rangeResult?.ok === true
              ? { status: "insufficient", segments: rangeResult.range.segments.length }
              : { status: "nothing-to-summarize" },
          durationMs: Date.now() - startedAt,
        },
      };
    }
    // 見込みが F に届くので書き換える。 要約の呼び出しより前に知らせる (先読みを待たせない)
    input.onWillRewrite?.();
  }
  if (rangeResult !== null) {
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
        if (boundary && stages.freedTokens.total < goal.minimumReductionTokens) {
          // 規則 2 は要約まで含めて F に届く見込みで行った。 要約が無ければ段階 0〜2 だけでは F に届かないので、
          // 設定 continue でも書き換えない (割に合わない書き換えをしない。 要約の失敗はそのまま失敗として出す)
          return fail(
            record.summary.status === "error" ? "summary-error" : "summary-failed",
            `${summaryFailureNote}。 段階 0〜2 だけでは最低量 ${goal.minimumReductionTokens.toLocaleString("en-US")} に届かないため、 書き換えませんでした`,
          );
        }
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

/**
 * 段階 3 の範囲 (§5.6)。 規則 1・2 は段階 0〜2 の後も目標と最低量に届かないときだけ、 届く最小の範囲を要約する。
 * 手動の /compact は届いていても、 要約してよい最大の範囲を要約する (段階 0〜3 を最後まで進める。 §7)。
 * 要約しないなら null。 整理イベントと /context の見込み (previewReduction) が同じものを使う。
 */
function selectStage3Range(
  trigger: ReductionTrigger,
  stages: ReductionStagesResult,
  originalLength: number,
  keepRecentToolUses: number,
): SummaryRangeResult | null {
  const manual = trigger === "manual";
  if (!stages.needsSummary && !manual) return null;
  return selectSummaryRange({
    messages: stages.messages,
    originalIndices: stages.originalIndices,
    originalLength,
    keepRecentToolUses,
    shortfall: stages.shortfall,
    widest: manual,
  });
}

// ─── 見込み・状態 (/context) ───

/** 直近の整理イベント (AgentLoop が持つ。 /compact と /context の表示に使う) */
export interface LastReductionEvent {
  /** 記録 (先読みを送ったときは、 先読みが終わると record.prewarm が埋まる) */
  record: ReductionEventRecord;
  /** 終わった時刻 (Date.now()) */
  finishedAt: number;
  /** 先読みを送ったか (送らなかった理由は record.prewarm の skipped) */
  prewarmSent: boolean;
}

/** 直近の規則 2 の見送り (/context の「直近の整理」 に出す) */
export interface LastReductionSkip {
  skip: ReductionSkipRecord;
  finishedAt: number;
}

/** /context に出す整理の状態 (利用者向けだけ。 モデルには見せない。 §8) */
export interface ReductionStatus {
  budget: ContextBudget;
  /** K と、 ツール結果 1 件の上限 */
  keepRecentToolUses: number;
  toolResultLimitTokens: number;
  promptSize: PromptSize;
  growth: RequestGrowth;
  /** G のもとになる直近の依頼の増分 (古い順。 3 件まで) */
  recentGrowths: readonly number[];
  /** 規則 1 の発火点 W − R (P がこれを超えたら次の本体呼び出しの前に整理する) */
  forcedLimitTokens: number;
  /** 規則 2 の発火点 W − R − G (強い区切りで P がこれを超えたら整理する) */
  boundaryLimitTokens: number;
  summaryFailurePolicy: SummaryFailurePolicy;
  preview: ReductionPreview;
  /** 直近の整理イベントか規則 2 の見送り */
  lastEvent: LastReductionEvent | LastReductionSkip | null;
}

export interface ReductionPreviewInput {
  /** 履歴 (getRawMessages())。 変更しない */
  messages: readonly Message[];
  budget: ContextBudget;
  /** いまの P */
  promptSize: PromptSize;
  /** いまの G */
  growthTokens: number;
  keepRecentToolUses: number;
  currentRequestStart: number;
  caseInsensitivePaths?: boolean;
}

export type ReductionPreview =
  | {
      ok: true;
      goal: ReductionGoal;
      /** 段階 0〜2 と前処理で減る量の見込み (送る形の推定) */
      freedTokens: ReductionStagesResult["freedTokens"];
      repaid: ReductionStagesResult["repaid"];
      forgottenCalls: number;
      clearedCurrentThinking: number;
      /** 段階 2 の後の P の見込み */
      promptTokensAfterStages: number;
      /** 段階 0〜2 だけでは目標・最低量に届かないか (規則 1・2 の整理なら段階 3 が要る) */
      needsSummary: boolean;
      shortfall: ReductionStagesResult["shortfall"];
      /**
       * 今 /compact したときの段階 3。 要約の呼び出しはしない (範囲を決めるだけ)。
       * would-summarize = 要約の呼び出しを送る (区間の数と、 見込みの減る量)、 nothing-to-summarize = 要約できる範囲が無い
       */
      summary:
        | { status: "would-summarize"; segments: number; estimatedFreedTokens: number }
        | { status: "nothing-to-summarize"; detail: string };
      /**
       * 規則 2 (区切りの自動の整理) なら行うか見送るか (§4.6)。 段階 3 は規則 1・2 の範囲 (目標と最低量に届く最小) で数える。
       * 規則 1 (作業の途中で入らない) は見込みにかかわらず行う
       */
      boundary: ReductionWorth;
    }
  | { ok: false; error: string };

/**
 * 今 /compact したら段階ごとにどれだけ減るかの見込み (§7 の /context)。 写しに前処理・段階 0〜2 を当てはめ、
 * 段階 3 は範囲を決めるだけで要約の呼び出しはしない。 履歴は変えない (純粋な関数)。
 */
export function previewReduction(input: ReductionPreviewInput): ReductionPreview {
  const goal = computeReductionGoal(input.budget, input.growthTokens);
  let stages: ReductionStagesResult;
  try {
    stages = applyReductionStages({
      messages: input.messages,
      currentRequestStart: input.currentRequestStart,
      keepRecentToolUses: input.keepRecentToolUses,
      promptTokens: input.promptSize.tokens,
      goal,
      caseInsensitivePaths: input.caseInsensitivePaths,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const range = selectStage3Range("manual", stages, input.messages.length, input.keepRecentToolUses);
  const boundaryRange = selectStage3Range(
    "boundary:request-end",
    stages,
    input.messages.length,
    input.keepRecentToolUses,
  );
  const summary: Extract<ReductionPreview, { ok: true }>["summary"] =
    range?.ok === true
      ? {
          status: "would-summarize",
          segments: range.range.segments.length,
          estimatedFreedTokens: range.range.estimatedFreedTokens,
        }
      : { status: "nothing-to-summarize", detail: range?.ok === false ? range.detail : "要約できる範囲がありません" };
  return {
    ok: true,
    goal,
    freedTokens: stages.freedTokens,
    repaid: stages.repaid,
    forgottenCalls: stages.forgotten.length,
    clearedCurrentThinking: stages.clearedCurrentThinking,
    promptTokensAfterStages: stages.promptTokensAfter,
    needsSummary: stages.needsSummary,
    shortfall: stages.shortfall,
    summary,
    boundary: assessReductionWorth(stages, boundaryRange, goal),
  };
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
    case "boundary:before-prewarm":
      return "先読みの前";
    default: {
      const exhaustive: never = trigger;
      return String(exhaustive);
    }
  }
}
