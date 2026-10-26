/**
 * 本体呼び出しでプロンプトキャッシュが外れたことの判定と、 原因の特定
 * (docs/context-reduction-redesign.md §10.2)。
 *
 * 判定: 今回の tokensCached が「比べる相手の入力 P − 4,096」 を下回ったら外れとみなす。 比べる相手は、 同じ並びを
 * サーバに読み込ませた直前の送信 = 前回の本体呼び出しか、 その後に送り終えた先読み (先読みが効いたかをここで見る)。
 * 4,096 は、 llama.cpp の混成モデルが末尾近くの保存点にしか戻れないことによる正常なずれ
 * (実測では毎回「前回の入力 − 4」) より十分大きく、 本物の外れ (数万〜十数万) より十分小さい幅。
 *
 * ずれ: 相手と今回の並びの指紋 (prompt-fingerprint.ts) を比べ、 設定・道具の定義・何件目の messages からずれたかを載せる。
 * 並びがずれていないのに外れたなら、 サーバ側 (スロットの違い・追い出し) を疑う。
 *
 * 原因: 比べる相手の送信から今回の送信までの間に起きたこと。
 *   - 整理イベント (reduction:<id>)。 整理の直後の外れは想定どおりなので expected: true
 *   - MessageHistory が申告した送信済み部分の書き換え理由 (prefix_break:<理由>)
 *   - 脇の呼び出しの目的 (side_call:<目的>)
 *   何も無ければ ["unknown"]。
 */
import { comparePromptFingerprints, type PromptDivergence, type PromptFingerprint } from "./prompt-fingerprint.js";
import type { SideCallPurpose } from "./side-call.js";

/** 前回の入力からこれだけ下回ったら外れとみなす幅 */
export const CACHE_MISS_TOLERANCE_TOKENS = 4_096;

/** 比べる相手の送信から今回の送信までの間に起きたこと */
export interface CacheMissCauses {
  reductionEventIds: string[];
  rewriteReasons: string[];
  sideCallPurposes: SideCallPurpose[];
}

/** 比べる相手にする送信 (本体呼び出しか、 送り終えた先読み) */
export interface PromptSend {
  kind: "main" | "prewarm";
  /** 入力トークン数 (キャッシュ分を含む全体)。 サーバが返さなければ undefined (次の判定をしない) */
  promptTokens?: number;
  fingerprint?: PromptFingerprint;
}

export interface CacheMissInput {
  /** 比べる相手。 まだ無ければ undefined */
  previous?: PromptSend;
  /** 今回の入力トークン数 (キャッシュ分を含む全体) */
  promptTokens?: number;
  /** 今回キャッシュで再利用された入力トークン数。 サーバが返さなければ undefined (判定しない) */
  tokensCached?: number;
  /** 今回の並びの指紋 */
  fingerprint?: PromptFingerprint;
  causes: CacheMissCauses;
}

export interface CacheMissDiagnosis {
  /** 比べた相手の種類 (前回の本体呼び出しか先読み) */
  against: PromptSend["kind"];
  /** 比べた相手の入力トークン数 */
  previousPromptTokens: number;
  promptTokens?: number;
  tokensCached: number;
  /** 「reduction:<id>」「prefix_break:<理由>」「side_call:<目的>」 の並び。 何も無ければ ["unknown"] */
  causes: string[];
  /** 整理イベントの直後で、 外れが想定どおり */
  expected: boolean;
  /** 相手と今回の並びのずれ (両方の指紋があるときだけ) */
  divergence?: PromptDivergence;
}

/** 外れていなければ (または判定に要る数が無ければ) null。 */
export function diagnoseCacheMiss(input: CacheMissInput): CacheMissDiagnosis | null {
  const { previous, tokensCached } = input;
  const previousPromptTokens = previous?.promptTokens;
  if (previous === undefined || previousPromptTokens === undefined || tokensCached === undefined) return null;
  if (tokensCached >= previousPromptTokens - CACHE_MISS_TOLERANCE_TOKENS) return null;
  const { reductionEventIds, rewriteReasons, sideCallPurposes } = input.causes;
  const causes = [
    ...reductionEventIds.map((id) => `reduction:${id}`),
    ...unique(rewriteReasons).map((reason) => `prefix_break:${reason}`),
    ...unique(sideCallPurposes).map((purpose) => `side_call:${purpose}`),
  ];
  const diagnosis: CacheMissDiagnosis = {
    against: previous.kind,
    previousPromptTokens,
    promptTokens: input.promptTokens,
    tokensCached,
    causes: causes.length > 0 ? causes : ["unknown"],
    expected: reductionEventIds.length > 0,
  };
  if (previous.fingerprint && input.fingerprint) {
    diagnosis.divergence = comparePromptFingerprints(previous.kind, previous.fingerprint, input.fingerprint);
  }
  return diagnosis;
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
  /** 比べる相手 (先読み) より前にたまっていた書き換え理由の件数。 次の take() で読み飛ばす */
  private skipRewriteReasons: { history: object; count: number } | null = null;

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

  /**
   * 比べる相手が先読みに替わったとき (先読みを送り終えたとき) に呼ぶ。 それまでにためたことは相手より前のことなので捨てる
   * (先読みは整理の後の並びを読み込んでいるので、 その整理は今回の外れの原因ではない)。
   * 書き換え理由は MessageHistory にたまっているので、 今たまっている件数 (pendingRewriteReasons) を受け取り、
   * 次の take() でその分を読み飛ばす。 件数は履歴ごとなので、 履歴を載せ替えたら読み飛ばさない。
   */
  restartFrom(history: object, pendingRewriteReasons: number): void {
    this.reductionEventIds = [];
    this.sideCallPurposes = [];
    this.skipRewriteReasons = { history, count: pendingRewriteReasons };
  }

  /**
   * ためたものを取り出して空にする。 書き換え理由は MessageHistory.takeRewriteReasons() の結果を、 その履歴と一緒に渡す。
   */
  take(rewriteReasons: string[], history?: object): CacheMissCauses {
    const skip = this.skipRewriteReasons;
    const causes: CacheMissCauses = {
      reductionEventIds: this.reductionEventIds,
      rewriteReasons: skip !== null && skip.history === history ? rewriteReasons.slice(skip.count) : rewriteReasons,
      sideCallPurposes: this.sideCallPurposes,
    };
    this.reductionEventIds = [];
    this.sideCallPurposes = [];
    this.skipRewriteReasons = null;
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
