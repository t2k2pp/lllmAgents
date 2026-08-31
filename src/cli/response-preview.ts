import { getDisplayWidth, stripAnsi, truncateToWidth } from "../utils/display-width.js";

const DEFAULT_COLUMNS = 80;
const PREVIEW_PREFIX = "  応答中: ";

/**
 * 生成途中の assistant text を、spinner の1行へ安全に載せるための表示文字列にする。
 *
 * 本文そのものは完了時に Markdown で確定表示するため、ここでは改行・制御文字だけを
 * 取り除いた一過性previewを返す。内容の意味分類や要約は行わない。
 */
function normalizePreview(text: string): string {
  return (
    stripAnsi(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal制御文字を除去する境界処理
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

function tokenStats(receivedTokens: number, tokensPerSecond: number): string {
  const rate = tokensPerSecond > 0 ? `, ${tokensPerSecond} tok/s` : "";
  return `${receivedTokens} tok${rate}`;
}

/**
 * buffered (streamingDisplay=false) 時の live status を組み立てる。
 * 狭い端末では token 統計より本文previewを優先し、折返しを起こさない。
 */
export function formatBufferedResponseStatus(
  text: string,
  receivedTokens: number,
  tokensPerSecond: number,
  columns: number = DEFAULT_COLUMNS,
): string {
  const maxColumns = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : DEFAULT_COLUMNS;
  const preview = normalizePreview(text);
  if (!preview) {
    return truncateToWidth(`  受信中... (${tokenStats(receivedTokens, tokensPerSecond)})`, maxColumns);
  }

  // 48桁未満では統計を外し、ユーザーが実際の応答内容を読める幅を確保する。
  const suffix = maxColumns >= 48 ? ` (${tokenStats(receivedTokens, tokensPerSecond)})` : "";
  const available = Math.max(1, maxColumns - getDisplayWidth(PREVIEW_PREFIX) - getDisplayWidth(suffix));
  return `${PREVIEW_PREFIX}${truncateToWidth(preview, available)}${suffix}`;
}
