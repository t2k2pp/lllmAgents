/**
 * 本体呼び出しでプロンプトキャッシュが外れたことの判定と、 原因の特定
 * (docs/context-reduction-redesign.md §10.2)。
 *
 * 判定: 今回の tokensCached が「前回の本体呼び出しの入力 P − 4,096」 を下回ったら外れとみなす。
 * 4,096 は、 llama.cpp の混成モデルが末尾近くの保存点にしか戻れないことによる正常なずれ
 * (実測では毎回「前回の入力 − 4」) より十分大きく、 本物の外れ (数万〜十数万) より十分小さい幅。
 *
 * 原因: 前回の本体呼び出しの送信から今回の送信までの間に起きたこと。
 *   - 整理イベント (reduction:<id>)。 整理の直後の外れは想定どおりなので expected: true
 *   - MessageHistory が申告した送信済み部分の書き換え理由 (prefix_break:<理由>)
 *   - 脇の呼び出しの目的 (side_call:<目的>)
 *   何も無ければ ["unknown"]。
 */
import type { SideCallPurpose } from "./side-call.js";

/** 前回の入力からこれだけ下回ったら外れとみなす幅 */
export const CACHE_MISS_TOLERANCE_TOKENS = 4_096;

/** 前回の本体呼び出しの送信から今回の送信までの間に起きたこと */
export interface CacheMissCauses {
  reductionEventIds: string[];
  rewriteReasons: string[];
  sideCallPurposes: SideCallPurpose[];
}

export interface CacheMissInput {
  /** 前回の本体呼び出しの入力トークン数 (キャッシュ分を含む全体)。 前回が無ければ undefined */
  previousPromptTokens?: number;
  /** 今回の入力トークン数 (キャッシュ分を含む全体) */
  promptTokens?: number;
  /** 今回キャッシュで再利用された入力トークン数。 サーバが返さなければ undefined (判定しない) */
  tokensCached?: number;
  causes: CacheMissCauses;
}

export interface CacheMissDiagnosis {
  previousPromptTokens: number;
  promptTokens?: number;
  tokensCached: number;
  /** 「reduction:<id>」「prefix_break:<理由>」「side_call:<目的>」 の並び。 何も無ければ ["unknown"] */
  causes: string[];
  /** 整理イベントの直後で、 外れが想定どおり */
  expected: boolean;
}

/** 外れていなければ (または判定に要る数が無ければ) null。 */
export function diagnoseCacheMiss(input: CacheMissInput): CacheMissDiagnosis | null {
  const { previousPromptTokens, tokensCached } = input;
  if (previousPromptTokens === undefined || tokensCached === undefined) return null;
  if (tokensCached >= previousPromptTokens - CACHE_MISS_TOLERANCE_TOKENS) return null;
  const { reductionEventIds, rewriteReasons, sideCallPurposes } = input.causes;
  const causes = [
    ...reductionEventIds.map((id) => `reduction:${id}`),
    ...unique(rewriteReasons).map((reason) => `prefix_break:${reason}`),
    ...unique(sideCallPurposes).map((purpose) => `side_call:${purpose}`),
  ];
  return {
    previousPromptTokens,
    promptTokens: input.promptTokens,
    tokensCached,
    causes: causes.length > 0 ? causes : ["unknown"],
    expected: reductionEventIds.length > 0,
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * 本体呼び出しの間に起きたことをためておく箱。 AgentLoop が 1 つ持つ。
 * 送信のたびに take() で取り出し、 その送信の応答で diagnoseCacheMiss() に渡す。
 */
export class CacheMissCauseCollector {
  private reductionEventIds: string[] = [];
  private sideCallPurposes: SideCallPurpose[] = [];

  /**
   * 整理イベントが履歴を差し替えたことを記録する。 整理イベントの実装 (設計書 §6.1 の手順 5) が、
   * MessageHistory.replaceMessages() の直後にイベント id を渡して呼ぶ。
   */
  noteReductionEvent(id: string): void {
    this.reductionEventIds.push(id);
  }

  noteSideCall(purpose: SideCallPurpose): void {
    this.sideCallPurposes.push(purpose);
  }

  /** ためたものを取り出して空にする。 書き換え理由は MessageHistory.takeRewriteReasons() の結果を渡す。 */
  take(rewriteReasons: string[]): CacheMissCauses {
    const causes: CacheMissCauses = {
      reductionEventIds: this.reductionEventIds,
      rewriteReasons,
      sideCallPurposes: this.sideCallPurposes,
    };
    this.reductionEventIds = [];
    this.sideCallPurposes = [];
    return causes;
  }
}

/** 接続の再試行で同じ本体呼び出しを送り直したとき、 前の試行で取り出した分と合わせる。 */
export function mergeCacheMissCauses(a: CacheMissCauses, b: CacheMissCauses): CacheMissCauses {
  return {
    reductionEventIds: [...a.reductionEventIds, ...b.reductionEventIds],
    rewriteReasons: [...a.rewriteReasons, ...b.rewriteReasons],
    sideCallPurposes: [...a.sideCallPurposes, ...b.sideCallPurposes],
  };
}
