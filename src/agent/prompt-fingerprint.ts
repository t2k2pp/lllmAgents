/**
 * 送った並びの指紋 (docs/context-reduction-redesign.md §10.2)。
 *
 * 本体呼び出し・先読み・要約は、 どれも同じ並び (system・道具の定義・それまでの会話) を先頭に持つので、 サーバの KV キャッシュを
 * 引き継げる。 キャッシュが外れたとき、 どこで並びがずれたかを後から見分けられるように、 送るたびに
 * 「設定・道具の定義・messages の 1 件ずつ」 の短いハッシュを記録する。
 *
 * 並びそのものではなく 8 文字のハッシュにする理由: 先読みと要約は並びの全体を送るので、 そのまま記録すると 1 回ごとに
 * 会話全体 (数十万文字) がログに増える。 ハッシュなら 1 件 11 バイトほど (300 件で約 3 KB) で、 2 つの送信を並べれば
 * 「設定か・道具か・何件目の messages からか」 が分かる。 1 件ずつに分けるのは、 ずれ始めの位置を求めるため
 * (全体を 1 つのハッシュにすると、 ずれたことしか分からない)。 隣り合う送信を比べるだけなので 32 ビットで足りる。
 */
import { createHash } from "node:crypto";

export interface PromptFingerprint {
  /** model とサンプリング・思考などの設定 (messages・道具の定義・出力上限・中断用の signal を除く) */
  settings: string;
  /** 道具の定義 (無ければ "-") */
  tools: string;
  /** messages の 1 件ずつ (送る形のまま) */
  messages: string[];
}

/** 指紋を残す送信の種類。 本体呼び出し・先読み・段階 3 の要約 */
export type PromptSendKind = "main" | "prewarm" | "summarize";

/** 2 つの送信の並びのずれ。 外れたときの記録 (cache_miss) に載せる */
export interface PromptDivergence {
  /** 比べた相手 (前の送信) の種類 */
  against: PromptSendKind;
  settingsChanged: boolean;
  toolsChanged: boolean;
  /** 前の送信と最初に違う messages の位置 (0 始まり。 0 は system)。 前の送信の messages がそのまま今回の先頭なら null */
  firstDifferentMessage: number | null;
  previousMessageCount: number;
  messageCount: number;
}

interface FingerprintSource {
  messages: readonly unknown[];
  tools?: readonly unknown[];
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** 送り方 (chat / chatWithTools の params) から指紋を作る */
export function fingerprintPrompt(params: FingerprintSource): PromptFingerprint {
  const {
    messages,
    tools,
    signal: _signal,
    maxTokens: _maxTokens,
    ...settings
  } = params as FingerprintSource & { signal?: unknown; maxTokens?: unknown };
  return {
    settings: shortHash(JSON.stringify(settings)),
    tools: tools === undefined || tools.length === 0 ? "-" : shortHash(JSON.stringify(tools)),
    messages: messages.map((m) => shortHash(JSON.stringify(m))),
  };
}

/** 前の送信 (previous) と今回 (current) の並びのずれを求める */
export function comparePromptFingerprints(
  against: PromptSendKind,
  previous: PromptFingerprint,
  current: PromptFingerprint,
): PromptDivergence {
  let i = 0;
  while (i < previous.messages.length && i < current.messages.length && previous.messages[i] === current.messages[i]) {
    i++;
  }
  return {
    against,
    settingsChanged: previous.settings !== current.settings,
    toolsChanged: previous.tools !== current.tools,
    firstDifferentMessage: i === previous.messages.length ? null : i,
    previousMessageCount: previous.messages.length,
    messageCount: current.messages.length,
  };
}
