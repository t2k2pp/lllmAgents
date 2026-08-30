import { getDisplayWidth, splitGraphemes } from "../utils/display-width.js";

export interface InputScreenLine {
  text: string;
  /** buffer 全体における、この物理行の開始UTF-16 index */
  startIndex: number;
}

export interface InputLayout {
  screenLines: InputScreenLine[];
  row: number;
  /** 物理行内のUTF-16 index。slice() と相互変換するため表示桁ではない。 */
  col: number;
}

/**
 * 入力bufferを端末の物理行へ配置する。
 *
 * DECAWM 対応端末は最終列を書いた直後に「折返し待ち」状態になる。その状態で再描画の
 * cursor命令を送ると、iTerm2/Terminal.app等で意図しない改行が確定することがある。
 * そのため入力行は最終列を常に1桁空け、端末自身のsoft wrapへ依存しない。
 */
export function layoutInputBuffer(
  buffer: string,
  cursorPos: number,
  prefixWidth: number,
  columns: number,
): InputLayout {
  if (!Number.isInteger(columns) || columns <= prefixWidth + 1) {
    throw new Error(
      `端末幅が入力欄には狭すぎます (columns=${columns}, prefix=${prefixWidth})。端末幅を広げて再実行してください。`,
    );
  }

  const maxPaintedColumn = columns - 1;
  const logicalLines = buffer.split("\n");
  const screenLines: InputScreenLine[] = [];
  let row = 0;
  let col = 0;
  let currentPos = 0;

  for (const logicalLine of logicalLines) {
    let currentScreenLine = "";
    let lineStartIndex = currentPos;
    let currentLineWidth = prefixWidth;

    if (logicalLine.length === 0) {
      if (currentPos === cursorPos) {
        row = screenLines.length;
        col = 0;
      }
      screenLines.push({ text: "", startIndex: lineStartIndex });
      currentPos++; // logical newline（末尾の空論理行ではbuffer外になるが次反復はない）
      continue;
    }

    for (const grapheme of splitGraphemes(logicalLine)) {
      if (currentPos === cursorPos) {
        row = screenLines.length;
        col = currentScreenLine.length;
      }

      const graphemeWidth = getDisplayWidth(grapheme);
      if (currentLineWidth + graphemeWidth > maxPaintedColumn) {
        screenLines.push({ text: currentScreenLine, startIndex: lineStartIndex });
        currentScreenLine = grapheme;
        lineStartIndex = currentPos;
        currentLineWidth = prefixWidth + graphemeWidth;
      } else {
        currentScreenLine += grapheme;
        currentLineWidth += graphemeWidth;
      }
      currentPos += grapheme.length;
    }

    if (currentPos === cursorPos) {
      row = screenLines.length;
      col = currentScreenLine.length;
    }
    screenLines.push({ text: currentScreenLine, startIndex: lineStartIndex });
    currentPos++; // logical newline
  }

  if (cursorPos === buffer.length) {
    row = Math.max(0, screenLines.length - 1);
    col = screenLines[row]?.text.length ?? 0;
  }

  return { screenLines, row, col };
}
