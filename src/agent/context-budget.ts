/**
 * コンテキスト整理の予算の計算 (docs/context-reduction-redesign.md §4 / §6.3。 整理の作り直し タスク 3)。
 *
 * ここにあるのは純粋な計算と、 依頼 1 件ごとの増分 G の記録だけ。 整理の発火には使わない
 * (本体呼び出しの直前・依頼の区切りへの組み込みはタスク 8。 それまでは既存の ContextManager の経路が動く)。
 * 例外は起動時・モデル切替時の検査 (checkContextWindowFits) で、 AgentLoop が呼ぶ。
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

export interface ContextBudget {
  tier: Tier;
  /** W */
  contextWindow: number;
  /** O */
  outputTokenLimit: number;
  /** T */
  toolResultTotalTokens: number;
  /** M */
  estimateMarginTokens: number;
  /** S */
  reductionMarginTokens: number;
  /** R = O + T + M + S */
  reserveTokens: number;
}

export function computeContextBudget(contextWindow: number, tier: Tier): ContextBudget {
  const d = TIER_CONTEXT_BUDGETS[tier];
  return {
    tier,
    contextWindow,
    outputTokenLimit: d.outputTokenLimit,
    toolResultTotalTokens: d.toolResultTotalTokens,
    estimateMarginTokens: d.estimateMarginTokens,
    reductionMarginTokens: d.reductionMarginTokens,
    reserveTokens: d.outputTokenLimit + d.toolResultTotalTokens + d.estimateMarginTokens + d.reductionMarginTokens,
  };
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
 * 依頼の始まり・本体呼び出し・整理・依頼の終わりで呼ぶ組み込みはタスク 8。
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

/** 切り詰めの注記 ("...(N bytes truncated for history; …)...") と role の枠に見込む文字数 */
const TOOL_RESULT_NOTE_ALLOWANCE_CHARS = 200;

/**
 * ツール結果 1 件の上限 (切り詰めの閾値。 文字数) を、 トークン数の上限に直す。
 * 推定 (estimateTokens) で最も多く数える場合 (全部が日本語などの全角文字 = 1 文字 1 トークン × 1.1) をとる。
 * P の推定と同じ数え方の最悪値にしておけば、 中身によらず「整理しても入らない」 が起きない。
 */
export function toolResultLimitTokens(limitChars: number): number {
  return Math.ceil((limitChars + TOOL_RESULT_NOTE_ALLOWANCE_CHARS) * 1.1);
}

export interface ContextWindowFitInput {
  contextWindow: number;
  tier: Tier;
  /** 固定部分 (system + ツール定義) の推定トークン数 */
  fixedTokens: number;
  /** ツール結果 1 件の切り詰めの閾値 (文字数。 capability.toolResultTruncateBytes) */
  toolResultLimitChars: number;
}

export interface ContextWindowFit {
  ok: boolean;
  contextWindow: number;
  /** 固定部分 + K × 1 件の上限 + 16,384 + R */
  requiredTokens: number;
  fixedTokens: number;
  keepRecentToolUses: number;
  recentToolResultTokens: number;
  conversationTokens: number;
  reserveTokens: number;
}

/**
 * 段階 0〜3 を最後まで行っても残る部分 (固定部分・直近 K 回のツール結果・会話の最小限) と予約 R が
 * 枠に入るか (設計書 §6.3)。 入らなければ、 整理しても次の呼び出しが入らないことがありうる。
 */
export function checkContextWindowFits(input: ContextWindowFitInput): ContextWindowFit {
  const budget = computeContextBudget(input.contextWindow, input.tier);
  const keepRecentToolUses = TIER_CONTEXT_BUDGETS[input.tier].keepRecentToolUses;
  const recentToolResultTokens = keepRecentToolUses * toolResultLimitTokens(input.toolResultLimitChars);
  const requiredTokens = input.fixedTokens + recentToolResultTokens + MIN_CONVERSATION_TOKENS + budget.reserveTokens;
  return {
    ok: requiredTokens <= input.contextWindow,
    contextWindow: input.contextWindow,
    requiredTokens,
    fixedTokens: input.fixedTokens,
    keepRecentToolUses,
    recentToolResultTokens,
    conversationTokens: MIN_CONVERSATION_TOKENS,
    reserveTokens: budget.reserveTokens,
  };
}

/** 検査に通らなかったときに利用者へ示す文 (理由と必要量) */
export function formatContextWindowTooSmall(fit: ContextWindowFit, modelId: string, tier: Tier): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    `contextWindow が小さすぎます (モデル '${modelId}'、 ティア ${tier}): ` +
    `${n(fit.contextWindow)} トークンに対して、 整理しても必ず残る部分と次の呼び出しの予約で ${n(fit.requiredTokens)} トークン要ります ` +
    `(固定部分 ${n(fit.fixedTokens)} + 直近 ${fit.keepRecentToolUses} 回のツール結果 ${n(fit.recentToolResultTokens)} + ` +
    `会話の最小限 ${n(fit.conversationTokens)} + 予約 ${n(fit.reserveTokens)})。 ` +
    `サーバ側の枠を ${n(fit.requiredTokens)} トークン以上にして mainLLM.contextWindow を合わせるか、 枠の大きいモデルを使ってください。`
  );
}
