/**
 * ターミナル表示幅の計算 (全角 = 2 桁)。
 *
 * もともと `src/cli/interactive-input.ts` にあったロジックをそのまま切り出したもの。
 * ScreenManager (docs/tui-alternate-screen.md §3.5) も同じ幅計算を必要とするが、
 * 幅計算を 2 箇所に書くと片方だけズレて描画が崩れる (§11 のリスク表)。
 * 新規に書き直さず、ここへ共通化して両方から使う。
 *
 * interactive-input.ts は互換のため `getDisplayWidth` を再エクスポートしている。
 */

/** ANSI の色指定 (SGR) を取り除く */
export function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI エスケープの検出そのものが目的
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Unicode East Asian Width に基づく全角判定。
 * CJK統合漢字、ひらがな、カタカナ、全角記号、ハングル等を検出。
 */
export function isFullwidthCodePoint(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f || // Hangul Jamo
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0x303e) || // CJK Radicals, Kangxi, Symbols
      (code >= 0x3040 && code <= 0x33bf) || // Hiragana, Katakana, CJK Compat
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x4e00 && code <= 0xa4cf) || // CJK Unified + Yi
      (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
      (code >= 0xfe10 && code <= 0xfe19) || // Vertical forms
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compat Forms
      (code >= 0xff01 && code <= 0xff60) || // Fullwidth ASCII
      (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
      (code >= 0x1f000 && code <= 0x1faff) || // Emoticons, Symbols
      (code >= 0x20000 && code <= 0x2fffd) || // CJK Extension B+
      (code >= 0x30000 && code <= 0x3fffd))
  );
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MARK = /^\p{Mark}$/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;

/** Unicode grapheme cluster（ユーザーが1文字として扱う単位）へ分割する。 */
export function splitGraphemes(str: string): string[] {
  return Array.from(graphemeSegmenter.segment(str), ({ segment }) => segment);
}

/** cursor が途中にあっても、直前の grapheme cluster の先頭を返す。 */
export function previousGraphemeBoundary(str: string, cursor: number): number {
  let previous = 0;
  for (const { index } of graphemeSegmenter.segment(str)) {
    if (index >= cursor) break;
    previous = index;
  }
  return previous;
}

/** cursor が途中にあっても、直後の grapheme cluster の末尾を返す。 */
export function nextGraphemeBoundary(str: string, cursor: number): number {
  for (const { index, segment } of graphemeSegmenter.segment(str)) {
    const end = index + segment.length;
    if (end > cursor) return end;
  }
  return str.length;
}

function getGraphemeWidth(grapheme: string): number {
  let hasPrintableBase = false;
  let wide = false;
  for (const char of grapheme) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 0x7f || code === 0x200d || code === 0xfe0e || code === 0xfe0f || MARK.test(char)) {
      continue;
    }
    hasPrintableBase = true;
    if (isFullwidthCodePoint(code) || EMOJI.test(char) || REGIONAL_INDICATOR.test(char)) wide = true;
  }
  if (!hasPrintableBase) return 0;
  // VS16 は直前の文字を emoji presentation（通常2桁）へ切り替える。
  return wide || grapheme.includes("\ufe0f") ? 2 : 1;
}

/**
 * 文字列のターミナル表示幅を計算する。
 * 全角文字(CJK, ひらがな, カタカナ等) = 2カラム、半角 = 1カラム。
 */
export function getDisplayWidth(str: string): number {
  let width = 0;
  for (const grapheme of splitGraphemes(str)) width += getGraphemeWidth(grapheme);
  return width;
}

/**
 * 表示幅でstrを切り詰める。maxCols を超える場合は末尾に "…" を付けて返す。
 * メニュー行がターミナル幅を超えて折り返すと描画が崩れるため使用。
 */
export function truncateToWidth(str: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (getDisplayWidth(str) <= maxCols) return str;
  let w = 0;
  let out = "";
  for (const ch of splitGraphemes(str)) {
    const cw = getDisplayWidth(ch);
    if (w + cw + 1 > maxCols) break; // "…"の1カラム分を確保
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** ANSI エスケープ (色・カーソル制御) の 1 シーケンス */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI エスケープの検出そのものが目的
const ANSI_TOKEN = /^\x1b\[[0-9;?]*[a-zA-Z]/;

/**
 * ANSI エスケープを保ったまま表示幅で切り詰める。
 *
 * ScreenManager が行を描くとき、ターミナル幅を超えた行は端末側で自動折り返しされ、
 * 「1 行 = 1 行」 という前提が崩れて全画面再描画がズレる。色を落とさずに桁だけ
 * 切り詰めたいので、`truncateToWidth` (色ごと数えてしまう) とは別に用意する。
 *
 * 切り詰めが起きた場合は末尾に色リセット (`\x1b[0m`) を付け、色が次行へ漏れないようにする。
 */
export function truncateAnsiToWidth(str: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  let width = 0;
  let out = "";
  let i = 0;
  let truncated = false;
  while (i < str.length) {
    const rest = str.slice(i);
    const esc = ANSI_TOKEN.exec(rest);
    if (esc) {
      // エスケープは幅 0。そのまま通す
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    const ch = String.fromCodePoint(rest.codePointAt(0) ?? 0);
    const code = ch.codePointAt(0) ?? 0;
    const cw = code < 32 ? 0 : isFullwidthCodePoint(code) ? 2 : 1;
    if (width + cw > maxCols) {
      truncated = true;
      break;
    }
    out += ch;
    width += cw;
    i += ch.length;
  }
  return truncated ? `${out}\x1b[0m` : out;
}

/**
 * ANSI装飾を保持したまま、表示幅で複数の物理行へ分割する。
 *
 * Alternate Screenでは端末任せの自動折り返しを使うとカーソル位置と行数がずれる。
 * ただし切り詰めると本文そのものが不可視になるため、ScreenManager側で明示的に
 * 折り返せる形へ変換する。返却行を連結すると、入力の可視文字を一文字も失わない。
 */
export function wrapAnsiToWidth(str: string, maxCols: number): string[] {
  if (maxCols <= 0) return [str];
  const lines: string[] = [];
  let out = "";
  let width = 0;
  let i = 0;

  while (i < str.length) {
    const rest = str.slice(i);
    const esc = ANSI_TOKEN.exec(rest);
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }

    const nextEscape = rest.indexOf("\x1b");
    const plain = nextEscape === -1 ? rest : rest.slice(0, nextEscape);
    for (const grapheme of splitGraphemes(plain)) {
      const graphemeWidth = getGraphemeWidth(grapheme);
      if (width > 0 && width + graphemeWidth > maxCols) {
        lines.push(out);
        out = "";
        width = 0;
      }
      out += grapheme;
      width += graphemeWidth;
    }
    i += plain.length;

    // 未対応のescape byteで無限loopしない。可視内容を落とさずそのまま保持する。
    if (plain.length === 0 && nextEscape === 0) {
      out += rest[0];
      i++;
    }
  }

  lines.push(out);
  return lines;
}
