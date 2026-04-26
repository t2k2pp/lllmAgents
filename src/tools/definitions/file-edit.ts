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

    let content = fs.readFileSync(filePath, "utf-8");
    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      // ファイルの現在の内容を添付してモデルの次の判断を助ける
      const lineCount = content.split("\n").length;
      const preview = content.length > 1500 ? content.slice(0, 1500) + "\n...(truncated)" : content;
      return {
        success: false,
        output: `ファイルの現在の内容 (${lineCount}行):\n${preview}`,
        error: "old_string not found in file. 正しい文字列で再試行するか、file_writeでファイル全体を書き直してください。",
      };
    }

    if (!replaceAll && occurrences > 1) {
      return {
        success: false,
        output: "",
        error: `old_string found ${occurrences} times. Use replace_all=true or provide a more unique string.`,
      };
    }

    if (replaceAll) {
      content = content.split(oldString).join(newString);
    } else {
      content = content.replace(oldString, newString);
    }

    fs.writeFileSync(filePath, content, "utf-8");
    const replacedCount = replaceAll ? occurrences : 1;
    // Phase 5-C1: 副次情報の標準同梱
    const stat = fs.statSync(filePath);
    const totalLines = content.split("\n").length;
    const meta = `[file_edit] replaced ${replacedCount} occurrence(s) in ${filePath} | ${stat.size} bytes | ${totalLines} lines | mtime=${stat.mtime.toISOString()}`;
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
