/**
 * ファイルツールの改行コードの扱い (docs/file-tools-line-endings.md が正本)。
 *
 * モデルは file_read の表示に `\r` が見えないため、 CRLF のファイルに対して
 * `\r\n` を含む old_string を作れない。 そこでファイル系ツールは
 *   - 照合・置換は LF に揃えた本文で行い
 *   - 書き戻すときはファイルが使っていた改行コードに戻す
 * (Claude Code の Edit / Write と同じ考え方)。 改行コードはモデルが指定するものではなく、
 * ファイルの属性として保つ。
 */

export type LineEnding = "\r\n" | "\n";

export interface LineEndingInfo {
  /** 書き戻しに使う改行コード (多い方。 同数なら LF) */
  eol: LineEnding;
  /** CRLF と単独 LF が混在していたか (書き戻すと eol に統一される) */
  mixed: boolean;
}

/** 本文の改行コードを判定する */
export function detectLineEnding(text: string): LineEndingInfo {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return { eol: crlf > lf ? "\r\n" : "\n", mixed: crlf > 0 && lf > 0 };
}

/** CRLF を LF に揃える */
export function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** LF に揃えた本文を指定の改行コードにする */
export function applyLineEnding(textLF: string, eol: LineEnding): string {
  return eol === "\r\n" ? textLF.replace(/\n/g, "\r\n") : textLF;
}

/** 結果表示用の短い説明。 LF のみのファイルでは何も言わない */
export function describeLineEnding(info: LineEndingInfo): string {
  if (info.mixed) return `改行コードが混在していたため ${info.eol === "\r\n" ? "CRLF" : "LF"} に統一して書き込みました`;
  return info.eol === "\r\n" ? "改行コード CRLF を保って書き込みました" : "";
}
