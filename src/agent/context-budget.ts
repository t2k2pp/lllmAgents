/**
 * コンテキスト整理の予算の計算 (docs/context-reduction-redesign.md §4 / §6.3。 整理の作り直し タスク 3)。
 *
 * ここにあるのは純粋な計算と、 依頼 1 件ごとの増分 G の記録だけ。 発火の判定 (規則 1・2) は AgentLoop が
 * 本体呼び出しの直前と強い区切りで、 起動時・モデル切替時の検査 (checkContextWindowFits) も AgentLoop が呼ぶ。
 *
 * 記号 (設計書 §4.1):
 *   W = contextWindow、 P = 次に送るプロンプトの大きさ、 O = 1 回の出力の上限、
 *   T = 1 回の応答のツール結果の合計の上限、 M = 推定の誤差の余白、 S = 整理に要る余白、
 *   R = O + T + M + S、 G = 次の「ひと仕事」 で増える量
 */
import type { Message, ToolDefinition } from "../providers/base-provider.js";
import { TIER_CONTEXT_BUDGETS, type Tier } from "./capability-tier.js";
import { estimateMessageTokens, estimateToolDefinitionTokens } from "./token-counter.js";

// ─── 予約 R ───────────────────────────────────────────────

/*
 * 予約の大きさは枠 W に比例させ、 上限・下限で挟む (2026-11-07 利用者と決定。 設計書 §4.2)。
 * 以前はティアごとの決め打ち (T2 で R = 67,584) で、 131K の枠では R が枠の 52% を占め、 実際の出力
 * (最大 9,748) の何倍もの場所を空けたまま「整理しても入らない」 で止まった。
 * ティアの値 (TIER_CONTEXT_BUDGETS) は大きさの上限として使い、 割合と下限はここで決める。
 */

/** O の割合と下限 (上限はティアの outputTokenLimit) */
export const OUTPUT_RATIO = 0.125;
export const OUTPUT_FLOOR_TOKENS = 4_096;
/** T の割合と下限 (上限はティアの toolResultTotalTokens) */
export const TOOL_RESULT_TOTAL_RATIO = 0.1;
export const TOOL_RESULT_TOTAL_FLOOR_TOKENS = 4_096;
/** ツール結果 1 件の上限 = T × この割合 (下限あり。 上限はティアの toolResultLimitTokens) */
export const TOOL_RESULT_LIMIT_RATIO = 0.4;
export const TOOL_RESULT_LIMIT_FLOOR_TOKENS = 1_024;
/** M の割合と下限 (上限はティアの estimateMarginTokens) */
export const ESTIMATE_MARGIN_RATIO = 0.03;
export const ESTIMATE_MARGIN_FLOOR_TOKENS = 2_048;
/** S の割合と下限 (上限はティアの reductionMarginTokens。 下限は要約の出力 3,072 が入る量) */
export const REDUCTION_MARGIN_RATIO = 0.03;
export const REDUCTION_MARGIN_FLOOR_TOKENS = 3_072;
/** R は枠のこの割合まで (超えるなら O と T を同じ比で縮める) */
export const MAX_RESERVE_RATIO = 0.35;
/**
 * 本体呼び出しの出力に最低限残す量。 整理しても P + (この量 + T + M + S) が枠を超えるときだけ止める。
 * 予約 R (目標) に届かないだけなら止めず、 その回の maxTokens を空きに縮めて続ける。
 */
export const MIN_MAIN_OUTPUT_TOKENS = 4_096;
/** 出力の見込みを実際の出力から決めるのに要る件数と、 実際の最大に掛ける倍率 */
export const OUTPUT_HISTORY_MIN_SAMPLES = 3;
export const OUTPUT_HISTORY_FACTOR = 1.5;

export interface ContextBudget {
  tier: Tier;
  /** W */
  contextWindow: number;
  /** O の上限: 本体呼び出しに渡す maxTokens の上限 (生成の暴走の歯止め) */
  outputTokenLimit: number;
  /** O の見込み: R に数える出力の量 (実際の出力が 3 件以上あれば 最大 × 1.5、 O の上限まで) */
  outputReserveTokens: number;
  /** 見込みの出どころ。 limit = O の上限そのまま、 recent = 実際の出力から */
  outputReserveSource: "limit" | "recent";
  /** T */
  toolResultTotalTokens: number;
  /** ツール結果 1 件の上限 (切り詰めと起動時検査に使う) */
  toolResultLimitTokens: number;
  /** M */
  estimateMarginTokens: number;
  /** S */
  reductionMarginTokens: number;
  /** R = O の見込み + T + M + S。 超えたら整理する (目標) */
  reserveTokens: number;
  /** 最低限の予約 = 最低の出力 + T + M + S。 整理してもこれが入らないときだけ止める */
  minimumReserveTokens: number;
}

export interface ContextBudgetOptions {
  /** 直近の本体呼び出しの出力の実数 (古い順)。 3 件以上あれば O の見込みに使う */
  recentOutputTokens?: readonly number[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function computeContextBudget(
  contextWindow: number,
  tier: Tier,
  options: ContextBudgetOptions = {},
): ContextBudget {
  const cap = TIER_CONTEXT_BUDGETS[tier];
  const w = Math.max(0, contextWindow);
  // 下限が上限を超えるティア (T3 の O 4,096 など) では上限を優先する
  const scaled = (ratio: number, floor: number, hi: number): number =>
    Math.floor(clamp(w * ratio, Math.min(floor, hi), hi));
  let output = scaled(OUTPUT_RATIO, OUTPUT_FLOOR_TOKENS, cap.outputTokenLimit);
  let toolTotal = scaled(TOOL_RESULT_TOTAL_RATIO, TOOL_RESULT_TOTAL_FLOOR_TOKENS, cap.toolResultTotalTokens);
  const margin = scaled(ESTIMATE_MARGIN_RATIO, ESTIMATE_MARGIN_FLOOR_TOKENS, cap.estimateMarginTokens);
  const reduction = scaled(REDUCTION_MARGIN_RATIO, REDUCTION_MARGIN_FLOOR_TOKENS, cap.reductionMarginTokens);
  // 下限のせいで R が枠の 35% を超える小さい枠では、 O と T を同じ比で縮める
  const maxOutputAndTools = Math.floor(w * MAX_RESERVE_RATIO) - margin - reduction;
  if (output + toolTotal > maxOutputAndTools) {
    const k = Math.max(0, maxOutputAndTools) / (output + toolTotal);
    output = Math.floor(output * k);
    toolTotal = Math.floor(toolTotal * k);
  }
  // 1 件の上限は T に比例させる (T を超えない)
  const toolLimit = Math.min(
    toolTotal,
    Math.floor(
      clamp(
        toolTotal * TOOL_RESULT_LIMIT_RATIO,
        Math.min(TOOL_RESULT_LIMIT_FLOOR_TOKENS, cap.toolResultLimitTokens),
        cap.toolResultLimitTokens,
      ),
    ),
  );
  const recent = (options.recentOutputTokens ?? []).filter((v) => Number.isFinite(v) && v >= 0);
  const fromRecent = recent.length >= OUTPUT_HISTORY_MIN_SAMPLES;
  const minOutput = Math.min(MIN_MAIN_OUTPUT_TOKENS, output);
  const outputReserve = fromRecent
    ? Math.min(output, Math.max(minOutput, Math.ceil(Math.max(...recent) * OUTPUT_HISTORY_FACTOR)))
    : output;
  return {
    tier,
    contextWindow,
    outputTokenLimit: output,
    outputReserveTokens: outputReserve,
    outputReserveSource: fromRecent ? "recent" : "limit",
    toolResultTotalTokens: toolTotal,
    toolResultLimitTokens: toolLimit,
    estimateMarginTokens: margin,
    reductionMarginTokens: reduction,
    reserveTokens: outputReserve + toolTotal + margin + reduction,
    minimumReserveTokens: minOutput + toolTotal + margin + reduction,
  };
}

/**
 * 本体呼び出しに渡す maxTokens = min(O の上限, W − P − T − M − S)。 出力の後に入るツール結果と整理の余白は空けておく。
 * 予約 R (目標) に届かず整理でも戻せなかったときも、 ここで縮めて呼び出しを続ける (止めるのは最低限の予約も入らないときだけ)。
 * 戻り値が MIN_MAIN_OUTPUT_TOKENS 未満なら、 最低限の予約が入っていない (呼び出し側は送らない)。
 */
export function computeMainOutputTokens(promptTokens: number, budget: ContextBudget): number {
  const room =
    budget.contextWindow -
    promptTokens -
    budget.toolResultTotalTokens -
    budget.estimateMarginTokens -
    budget.reductionMarginTokens;
  return Math.max(0, Math.min(budget.outputTokenLimit, room));
}

// ─── P の求め方 ───────────────────────────────────────────

export interface PromptSize {
  tokens: number;
  /**
   * usage = 直前の本体呼び出しでサーバが返した実数が土台 (その後に足した分だけ推定)。
   * estimate = 実数が無いので全体を文字数から推定した。
   */
  basis: "usage" | "estimate";
}

export interface PromptSizeInput {
  /**
   * 直前の本体呼び出しの実数。 promptTokens は入力の全体 (Anthropic 系はキャッシュ読込・書込を足した値。
   * AgentLoop の previousMainPromptTokens と同じ)、 outputTokens はその呼び出しの出力。
   * 起動直後・整理直後・usage を返さない provider では null。
   */
  lastMainCall: { promptTokens: number; outputTokens: number } | null;
  /** 直前の本体呼び出しの後に足したもの (ツール結果・状態通知)。 その呼び出しの出力そのものは含めない */
  addedSinceLastCall: Message[];
  /** 実数が無いときに推定する、 送る予定のメッセージ全体 (system を含む) */
  messages: Message[];
  /** 実数が無いときに推定する、 送る予定のツール定義 */
  tools: ToolDefinition[];
}

export function measurePromptSize(input: PromptSizeInput): PromptSize {
  const last = input.lastMainCall;
  if (last && last.promptTokens > 0) {
    return {
      tokens: last.promptTokens + last.outputTokens + estimateMessageTokens(input.addedSinceLastCall),
      basis: "usage",
    };
  }
  return {
    tokens: estimateMessageTokens(input.messages) + estimateToolDefinitionTokens(input.tools),
    basis: "estimate",
  };
}

// ─── 発火の 2 つの規則と、 整理の目標 ─────────────────────

/** 規則 1 (強制): P + R > W なら、 次の本体呼び出しの前に整理する */
export function exceedsForcedLimit(promptTokens: number, budget: ContextBudget): boolean {
  return promptTokens + budget.reserveTokens > budget.contextWindow;
}

/** 整理しても P + 最低限の予約 > W なら、 次の本体呼び出しは本当に入らない (止める条件) */
export function exceedsMinimumLimit(promptTokens: number, budget: ContextBudget): boolean {
  return promptTokens + budget.minimumReserveTokens > budget.contextWindow;
}

/** 規則 2 (強い区切りでの先回り): P + R + G > W なら整理する */
export function exceedsBoundaryLimit(promptTokens: number, budget: ContextBudget, growthTokens: number): boolean {
  return promptTokens + budget.reserveTokens + growthTokens > budget.contextWindow;
}

/** 1 回の整理で減らす最低量 F = max(32,768, G ÷ 2) の下限 */
export const MINIMUM_REDUCTION_FLOOR_TOKENS = 32_768;

export interface ReductionGoal {
  /** 整理後の P の上限 = W − R − G */
  targetPromptTokens: number;
  /** 1 回の整理で少なくとも減らす量 F */
  minimumReductionTokens: number;
}

export function computeReductionGoal(budget: ContextBudget, growthTokens: number): ReductionGoal {
  return {
    targetPromptTokens: budget.contextWindow - budget.reserveTokens - growthTokens,
    minimumReductionTokens: Math.max(MINIMUM_REDUCTION_FLOOR_TOKENS, Math.floor(growthTokens / 2)),
  };
}

// ─── ひと仕事の増分 G ─────────────────────────────────────

/** 直近の依頼がこの件数そろうまでは既定値を使う */
export const RECENT_REQUEST_COUNT = 3;
/** 3 件そろうまでの G の既定値 (≈ 1 回 2.3k × 35 回。 設計書 §4.5) */
export const DEFAULT_REQUEST_GROWTH_TOKENS = 80_000;

export interface RequestGrowth {
  /** 頭打ち後の G */
  tokens: number;
  /** default = 3 件そろっていないので既定値。 recent-max = 直近 3 件の最大 */
  source: "default" | "recent-max";
  /** (W − R) ÷ 2 で頭打ちにしたか */
  capped: boolean;
  /** 頭打ちの値 (W − R) ÷ 2 */
  capTokens: number;
}

export function resolveRequestGrowth(recentGrowths: readonly number[], budget: ContextBudget): RequestGrowth {
  const capTokens = Math.max(0, Math.floor((budget.contextWindow - budget.reserveTokens) / 2));
  const enough = recentGrowths.length >= RECENT_REQUEST_COUNT;
  const raw = enough ? Math.max(...recentGrowths.slice(-RECENT_REQUEST_COUNT)) : DEFAULT_REQUEST_GROWTH_TOKENS;
  return {
    tokens: Math.min(raw, capTokens),
    source: enough ? "recent-max" : "default",
    capped: raw > capTokens,
    capTokens,
  };
}

/** セッションに保存する G の記録 (SessionData.requestGrowth) */
export interface RequestGrowthSnapshot {
  version: 1;
  /** 直近の依頼の増分 (古い順、 最大 RECENT_REQUEST_COUNT 件) */
  recent: number[];
  /** 途中の依頼 (保存した時点で依頼の途中だった場合)。 無ければ null */
  current: CurrentRequestSnapshot | null;
}

interface CurrentRequestSnapshot {
  /** 依頼の最初の本体呼び出しの入力 P。 まだ本体を呼んでいなければ null */
  firstPromptTokens: number | null;
  /** 最後の本体呼び出しの入力 P と出力 */
  lastPromptTokens: number | null;
  lastOutputTokens: number | null;
  /** 依頼の途中の整理で減らした量の合計 (足し戻す) */
  reducedTokens: number;
}

export type RequestGrowthRestoreResult = { ok: true; tracker: RequestGrowthTracker } | { ok: false; error: string };

/**
 * 1 件の依頼 (利用者の発話から依頼の終わりまで) の増分を測り、 直近 3 件を持つ (設計書 §4.5)。
 *   増分 = 最後の本体呼び出しの入力 P + その出力 − 最初の本体呼び出しの入力 P + 途中の整理で減らした量
 * 依頼の始まり・本体呼び出し・整理・依頼の終わりで AgentLoop が呼ぶ。
 */
export class RequestGrowthTracker {
  private recent: number[] = [];
  private current: CurrentRequestSnapshot | null = null;

  /**
   * 利用者の発話を受けて依頼を始めたとき。 前の依頼が終わっていなければ (中断など)、
   * そこまでに増えた量も実際に増えた量なので、 先に endRequest() で記録してから始める。
   */
  beginRequest(): void {
    if (this.current) this.endRequest();
    this.current = { firstPromptTokens: null, lastPromptTokens: null, lastOutputTokens: null, reducedTokens: 0 };
  }

  /** 本体呼び出しの応答で、 実数 (入力の全体と出力) を渡す。 依頼の外では何もしない */
  noteMainCall(promptTokens: number, outputTokens: number): void {
    if (!this.current) return;
    if (this.current.firstPromptTokens === null) this.current.firstPromptTokens = promptTokens;
    this.current.lastPromptTokens = promptTokens;
    this.current.lastOutputTokens = outputTokens;
  }

  /**
   * 依頼の途中の整理で減らした量 (整理前の P − 整理後の P)。 整理の後の本体呼び出しの P は
   * その分小さくなるので、 増分を測るときに足し戻す。
   */
  noteReduction(removedTokens: number): void {
    if (!this.current) return;
    this.current.reducedTokens += Math.max(0, removedTokens);
  }

  /**
   * 依頼の終わり。 測れた増分を記録して返す。 依頼が始まっていない・本体呼び出しの実数が 1 件も
   * 無いときは記録せず null (増分を作り話で埋めない)。
   */
  endRequest(): number | null {
    const cur = this.current;
    this.current = null;
    if (!cur || cur.firstPromptTokens === null || cur.lastPromptTokens === null) return null;
    const growth = Math.max(
      0,
      cur.lastPromptTokens + (cur.lastOutputTokens ?? 0) - cur.firstPromptTokens + cur.reducedTokens,
    );
    this.recent.push(growth);
    if (this.recent.length > RECENT_REQUEST_COUNT) this.recent = this.recent.slice(-RECENT_REQUEST_COUNT);
    return growth;
  }

  /** 直近の増分 (古い順) */
  recentGrowths(): readonly number[] {
    return [...this.recent];
  }

  /** いまの G (既定値・頭打ちを含む) */
  resolve(budget: ContextBudget): RequestGrowth {
    return resolveRequestGrowth(this.recent, budget);
  }

  toSnapshot(): RequestGrowthSnapshot {
    return { version: 1, recent: [...this.recent], current: this.current ? { ...this.current } : null };
  }

  /**
   * セッションから戻す。 undefined (この記録が無い古いセッション) は空の記録として始める。
   * 形が壊れているときは黙って空にせず、 失敗として返す (呼び出し側が利用者に知らせる)。
   */
  static restore(raw: unknown): RequestGrowthRestoreResult {
    const tracker = new RequestGrowthTracker();
    if (raw === undefined) return { ok: true, tracker };
    if (!isRecord(raw) || raw.version !== 1) {
      return { ok: false, error: "requestGrowth の形が不正です (version 1 のオブジェクトではありません)" };
    }
    if (!Array.isArray(raw.recent) || !raw.recent.every(isTokenCount)) {
      return { ok: false, error: "requestGrowth.recent が 0 以上の数の配列ではありません" };
    }
    if (raw.recent.length > RECENT_REQUEST_COUNT) {
      return { ok: false, error: `requestGrowth.recent が ${RECENT_REQUEST_COUNT} 件を超えています` };
    }
    let current: CurrentRequestSnapshot | null = null;
    if (raw.current !== null) {
      const c = raw.current;
      if (
        !isRecord(c) ||
        !isTokenCountOrNull(c.firstPromptTokens) ||
        !isTokenCountOrNull(c.lastPromptTokens) ||
        !isTokenCountOrNull(c.lastOutputTokens) ||
        !isTokenCount(c.reducedTokens)
      ) {
        return { ok: false, error: "requestGrowth.current の形が不正です" };
      }
      current = {
        firstPromptTokens: c.firstPromptTokens,
        lastPromptTokens: c.lastPromptTokens,
        lastOutputTokens: c.lastOutputTokens,
        reducedTokens: c.reducedTokens,
      };
    }
    tracker.recent = [...raw.recent];
    tracker.current = current;
    return { ok: true, tracker };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isTokenCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isTokenCountOrNull(v: unknown): v is number | null {
  return v === null || isTokenCount(v);
}

// ─── 起動時 (とモデル切替時) の検査 ───────────────────────

/** 整理しても必ず残る会話の最小限 (今の依頼の発話・要約・状態通知) に見込む量 (設計書 §6.3) */
export const MIN_CONVERSATION_TOKENS = 16_384;

export interface ContextWindowFitInput {
  contextWindow: number;
  tier: Tier;
  /** 固定部分 (system + ツール定義) の推定トークン数 */
  fixedTokens: number;
}

export interface ContextWindowFit {
  ok: boolean;
  contextWindow: number;
  /** 固定部分 + K × 1 件の上限 + 16,384 + R */
  requiredTokens: number;
  fixedTokens: number;
  keepRecentToolUses: number;
  /** ツール結果 1 件の上限 (computeContextBudget の toolResultLimitTokens。 切り詰めと同じ値) */
  toolResultLimitTokens: number;
  recentToolResultTokens: number;
  conversationTokens: number;
  /** 最低限の予約 (止める条件と同じ。 R の目標ではない) */
  reserveTokens: number;
  /** この固定部分とティアで起動できる最小の枠 (必要量は枠に比例して増えるので、 requiredTokens とは別に求める) */
  minimumContextWindow: number;
}

/**
 * 段階 0〜3 を最後まで行っても残る部分 (固定部分・直近 K 回のツール結果・会話の最小限) と予約 R が
 * 枠に入るか (設計書 §6.3)。 入らなければ、 整理しても次の呼び出しが入らないことがありうる。
 */
export function checkContextWindowFits(input: ContextWindowFitInput): ContextWindowFit {
  const budget = computeContextBudget(input.contextWindow, input.tier);
  const { keepRecentToolUses } = TIER_CONTEXT_BUDGETS[input.tier];
  const { toolResultLimitTokens } = budget;
  // 1 件の上限はツール結果を履歴に入れるときの切り詰め (tool-result-limit.ts) と同じトークン数・同じ数え方なので、
  // 最悪値に直さずにそのまま掛ける (file_write / file_edit は切らないが、 結果は短い)
  const recentToolResultTokens = keepRecentToolUses * toolResultLimitTokens;
  // 止める条件 (exceedsMinimumLimit) と同じく、 最低限の予約で確かめる (R は整理を始める目標で、 届かなくても止めない)
  const requiredTokens =
    input.fixedTokens + recentToolResultTokens + MIN_CONVERSATION_TOKENS + budget.minimumReserveTokens;
  return {
    ok: requiredTokens <= input.contextWindow,
    contextWindow: input.contextWindow,
    minimumContextWindow: findMinimumContextWindow(input.tier, input.fixedTokens),
    requiredTokens,
    fixedTokens: input.fixedTokens,
    keepRecentToolUses,
    toolResultLimitTokens,
    recentToolResultTokens,
    conversationTokens: MIN_CONVERSATION_TOKENS,
    reserveTokens: budget.minimumReserveTokens,
  };
}

/** 起動時検査の必要量 (枠 W のとき) */
function requiredTokensAt(contextWindow: number, tier: Tier, fixedTokens: number): number {
  const budget = computeContextBudget(contextWindow, tier);
  const { keepRecentToolUses } = TIER_CONTEXT_BUDGETS[tier];
  return (
    fixedTokens +
    keepRecentToolUses * budget.toolResultLimitTokens +
    MIN_CONVERSATION_TOKENS +
    budget.minimumReserveTokens
  );
}

/**
 * 起動時検査に通る最小の枠。 必要量は枠に比例して増える (予約が W に比例するため) が、 増え方は W より緩いので
 * 「必要量 ≤ W」 は W について単調。 二分探索で求める。
 */
export function findMinimumContextWindow(tier: Tier, fixedTokens: number): number {
  let lo = 0;
  let hi = 1 << 24;
  if (requiredTokensAt(hi, tier, fixedTokens) > hi) return hi;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (requiredTokensAt(mid, tier, fixedTokens) <= mid) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 検査に通らなかったときに利用者へ示す文 (理由と必要量) */
export function formatContextWindowTooSmall(fit: ContextWindowFit, modelId: string, tier: Tier): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    `contextWindow が小さすぎます (モデル '${modelId}'、 ティア ${tier}): ` +
    `${n(fit.contextWindow)} トークンに対して、 整理しても必ず残る部分と次の呼び出しの予約で ${n(fit.requiredTokens)} トークン要ります ` +
    `(固定部分 ${n(fit.fixedTokens)} + 直近 ${fit.keepRecentToolUses} 回のツール結果 ${n(fit.recentToolResultTokens)} + ` +
    `会話の最小限 ${n(fit.conversationTokens)} + 予約 ${n(fit.reserveTokens)})。 ` +
    `サーバ側の枠を ${n(fit.minimumContextWindow)} トークン以上にして mainLLM.contextWindow を合わせるか、 枠の大きいモデルを使ってください。`
  );
}

// ─── 利用者の入力の検査 ───────────────────────────────────

export interface UserInputFitInput {
  /** 入力 (利用者の発話のテキスト部分) の推定トークン数 */
  inputTokens: number;
  contextWindow: number;
  tier: Tier;
  /** 固定部分 (system + ツール定義) の推定トークン数 */
  fixedTokens: number;
}

export interface UserInputFit {
  ok: boolean;
  inputTokens: number;
  /** この入力を受け付けられる最大 = W − (固定部分 + 最小限の保護部分 + R) */
  maxInputTokens: number;
  contextWindow: number;
}

/**
 * 送信時の利用者の入力の検査 (設計書 §4.3)。 利用者の発言はどの段階でも原文のまま残す (§5.1) ので、
 * 「入力 + 固定部分 + 最小限の保護部分 (直近 K 回のツール結果 + 会話の最小限) + R > W」 の入力は、
 * 整理しても次の呼び出しが入らない。 受け付けずにファイルにして渡すよう案内する (整理の逃げ道ではない)。
 */
export function checkUserInputFits(input: UserInputFitInput): UserInputFit {
  const window = checkContextWindowFits({
    contextWindow: input.contextWindow,
    tier: input.tier,
    fixedTokens: input.fixedTokens,
  });
  const maxInputTokens = Math.max(0, input.contextWindow - window.requiredTokens);
  return {
    ok: input.inputTokens <= maxInputTokens,
    inputTokens: input.inputTokens,
    maxInputTokens,
    contextWindow: input.contextWindow,
  };
}

/** 入力の検査に通らなかったときに利用者へ示す文 */
export function formatUserInputTooLarge(fit: UserInputFit): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    `入力が大きすぎるため受け付けませんでした (推定 ${n(fit.inputTokens)} トークン。 contextWindow ${n(fit.contextWindow)} では ` +
    `${n(fit.maxInputTokens)} トークンまで)。 利用者の発言は整理でも縮めずに残すので、 この大きさでは次の呼び出しが入りません。 ` +
    `内容をファイルに保存し、 そのファイルの絶対パスを書いて「このファイルを読んで …」 のように依頼してください。`
  );
}
