/**
 * コンテキストウインドウサイズ (トークン数) の入力の解釈と表示。
 *
 * モデル一覧は `ctx: 131K` のように K/M で見せるので、 入力も同じ書き方を受け付ける。
 * K は 1,000・M は 1,000,000 (表示の formatContextSize と同じ)。 1,024 倍にすると
 * 「131K」が 134,144 になってモデルの上限 131,072 を超え、 サーバが 400 を返すため。
 */

import { parseTokenCount } from "./types.js";

/** 解釈できない入力のときのメッセージ (validate がそのまま利用者に見せる)。 */
export const CONTEXT_SIZE_HINT = "数字か K/M 付きで入力してください (例: 131072 / 131K / 128k / 1M / 1.5M)";

/**
 * "131072" / "131,072" / "131K" / "128k" / "1M" / "1.5m" をトークン数にする。
 * 空・0 以下・整数にならない・解釈できない入力は null (黙って既定値に置き換えない)。
 */
export function parseContextSize(text: string): number | null {
  const tokens = parseTokenCount(text); // 解釈の正は types.ts の parseTokenCount (/model context 128k と同じ)
  return Number.isNaN(tokens) ? null : tokens;
}

/**
 * モデル一覧などの短い表示 (131072 → "131K"・32768 → "32K")。
 * 切り捨てにする: 表示をそのまま打ち込んでもモデルの上限を超えないように (四捨五入だと 32768 が "33K"＝33,000 になる)。
 */
export function formatContextSize(tokens: number): string {
  if (tokens >= 1000000) return `${(Math.floor(tokens / 100000) / 10).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.floor(tokens / 1000)}K`;
  return `${tokens}`;
}
