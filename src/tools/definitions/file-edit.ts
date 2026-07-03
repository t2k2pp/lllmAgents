import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const fileEditTool: ToolHandler = {
  name: "file_edit",
  definition: {
    type: "function",
    function: {
      name: "file_edit",
      description:
        "ファイル内の文字列を置換して部分編集する。old_string がファイル内で一意であることが前提。\n" +
        "[使うべき場面] 数行〜数十行の修正。Read で確認した直後の編集。\n" +
        "[使うべきでない] (1) ファイル全体の置換 → file_write の方が確実。 " +
        "(2) Read していないファイル → 内容を知らずに old_string を当てるのは無理。先に file_read。\n" +
        "[よくある誤用] (a) 空白・タブ・改行コードの違いで old_string が一致しない → ファイル先頭の方をそのままコピーして指定。 " +
        "(b) 同じ文字列が複数箇所 → replace_all=true、または前後を含めて一意化。 " +
        "[副次情報] 失敗時はファイル現状を添付。同ファイルで連続失敗時は file_write 推奨に切り替えて。",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "編集するファイルの絶対パス",
          },
          old_string: {
            type: "string",
            description: "置換する元のテキスト（ファイル内で一意であること）",
          },
          new_string: {
            type: "string",
            description: "置換後のテキスト",
          },
          replace_all: {
            type: "boolean",
            description: "全ての出現箇所を置換する場合true（デフォルト: false）",
          },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = path.resolve(params.file_path as string);
    const oldString = params.old_string as string;
    const newString = params.new_string as string;
    const replaceAll = (params.replace_all as boolean) ?? false;

    if (!fs.existsSync(filePath)) {
      return { success: false, output: "", error: `File not found: ${filePath}` };
    }

    const beforeContent = fs.readFileSync(filePath, "utf-8");
    const occurrences = beforeContent.split(oldString).length - 1;

    if (occurrences === 0) {
      // ファイルの現在の内容を添付してモデルの次の判断を助ける
      const lineCount = beforeContent.split("\n").length;
      const preview = beforeContent.length > 1500 ? beforeContent.slice(0, 1500) + "\n...(truncated)" : beforeContent;
      return {
        success: false,
        output: `ファイルの現在の内容 (${lineCount}行):\n${preview}`,
        error:
          "old_string not found in file. 正しい文字列で再試行するか、file_writeでファイル全体を書き直してください。",
      };
    }

    if (!replaceAll && occurrences > 1) {
      // P0-B: 重複箇所の場所を行番号 + ±2 行コンテキストで示し、 一意化を即座に判断できるようにする。
      // T50/T53/T98 のような「同じ duplicate-error を 3 回繰り返す」 失敗パターンの対策。
      const matchPreview = formatDuplicateMatches(beforeContent, oldString);
      return {
        success: false,
        output: matchPreview,
        error: `old_string found ${occurrences} times. Use replace_all=true or provide a more unique string.`,
      };
    }

    const content = replaceAll
      ? beforeContent.split(oldString).join(newString)
      : beforeContent.replace(oldString, newString);

    fs.writeFileSync(filePath, content, "utf-8");
    const replacedCount = replaceAll ? occurrences : 1;
    // Phase 5-C1: 副次情報の標準同梱
    const stat = fs.statSync(filePath);
    const totalLines = content.split("\n").length;
    // P0-B: 編集箇所 ±20 行のスニペットを同梱して、 直後の file_read を不要にする。
    // 観測ログでは file_edit 直後に同じファイルを read し直す行動が頻発 (15-15 セッションで app.js を 22 回読込)。
    const editedSnippet = formatEditedSnippet(beforeContent, content, oldString, newString, replaceAll);
    const meta =
      `[file_edit] replaced ${replacedCount} occurrence(s) in ${filePath} | ${stat.size} bytes | ${totalLines} lines | mtime=${stat.mtime.toISOString()}\n\n` +
      editedSnippet +
      "\n\n[ハーネス] 編集箇所のコンテキストは上記スニペットに含まれています。 同じファイルを直後に file_read で読み直す必要はありません。 別箇所を見たい時のみ file_read を使ってください。";
    return {
      success: true,
      output: meta,
      userDisplay: {
        type: "edit-diff",
        filePath,
        oldString,
        newString,
        occurrences: replacedCount,
      },
    };
  },
};

/**
 * P0-B: 編集箇所 ±20 行のスニペットを返す。 直後の file_read を不要にするため。
 *
 * - 単数置換時: 編集後ファイルの該当箇所 + 前後 20 行
 * - 全件置換時: 最初の出現箇所周辺だけを示す (全部出すと冗長)
 */
function formatEditedSnippet(
  before: string,
  after: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  contextLines = 20,
): string {
  // before content のうち最初の oldString が現れる位置を行番号に変換
  const firstIdx = before.indexOf(oldString);
  if (firstIdx < 0) return "";
  const beforeUpToMatch = before.slice(0, firstIdx);
  const startLineInBefore = beforeUpToMatch.split("\n").length; // 1-indexed
  // after の行数換算では new_string の行数が old_string と異なる可能性
  // 編集後の同じ位置 (= 編集後ファイルでの先頭側 firstIdx 文字) から行番号取得
  const afterHead = after.slice(0, firstIdx);
  const startLineInAfter = afterHead.split("\n").length;
  const newLineCount = newString.split("\n").length;
  const endLineInAfter = startLineInAfter + newLineCount - 1;

  const afterLines = after.split("\n");
  const fromLine = Math.max(1, startLineInAfter - contextLines);
  const toLine = Math.min(afterLines.length, endLineInAfter + contextLines);
  const slice = afterLines.slice(fromLine - 1, toLine);
  const numbered = slice
    .map((ln, i) => {
      const lineNo = fromLine + i;
      const isEdited = lineNo >= startLineInAfter && lineNo <= endLineInAfter;
      const marker = isEdited ? ">" : " ";
      return `${marker} ${String(lineNo).padStart(5, " ")}\t${ln}`;
    })
    .join("\n");
  const header = replaceAll
    ? `[編集箇所スニペット (最初の出現位置周辺)] L${fromLine}-L${toLine} (編集前 L${startLineInBefore}~)`
    : `[編集箇所スニペット] L${fromLine}-L${toLine} (編集箇所: L${startLineInAfter}-L${endLineInAfter})`;
  return `${header}\n${numbered}`;
}

/**
 * P0-B: old_string が複数箇所マッチしたとき、 各マッチの行番号と前後 2 行を返す。
 * モデルが「どの箇所か」 を即座に区別して replace_all か一意化を判断できるようにする。
 */
function formatDuplicateMatches(content: string, oldString: string, contextLines = 2): string {
  const lines = content.split("\n");
  // oldString の各出現位置を文字オフセットで列挙
  const offsets: number[] = [];
  let from = 0;
  while (true) {
    const idx = content.indexOf(oldString, from);
    if (idx < 0) break;
    offsets.push(idx);
    from = idx + Math.max(1, oldString.length);
  }
  // 各オフセットを行番号に変換
  const matches = offsets.map((off) => {
    const head = content.slice(0, off);
    const startLine = head.split("\n").length;
    const oldLineCount = oldString.split("\n").length;
    return { startLine, endLine: startLine + oldLineCount - 1 };
  });
  // 各マッチを ±contextLines で表示 (上限 5 件まで、 残りは件数だけ)
  const shown = matches.slice(0, 5);
  const blocks = shown.map((m, i) => {
    const fromLine = Math.max(1, m.startLine - contextLines);
    const toLine = Math.min(lines.length, m.endLine + contextLines);
    const numbered = lines
      .slice(fromLine - 1, toLine)
      .map((ln, j) => {
        const lineNo = fromLine + j;
        const isMatch = lineNo >= m.startLine && lineNo <= m.endLine;
        const marker = isMatch ? ">" : " ";
        return `${marker} ${String(lineNo).padStart(5, " ")}\t${ln}`;
      })
      .join("\n");
    return `--- match #${i + 1}: L${m.startLine}-L${m.endLine} ---\n${numbered}`;
  });
  const remainder = matches.length > shown.length ? `\n... (and ${matches.length - shown.length} more match(es))` : "";
  return `[duplicate matches found at ${matches.length} location(s)]\n${blocks.join("\n\n")}${remainder}`;
}
