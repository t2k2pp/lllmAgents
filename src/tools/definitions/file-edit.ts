import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const fileEditTool: ToolHandler = {
  name: "file_edit",
  definition: {
    type: "function",
    function: {
      name: "file_edit",
      description: "ファイル内の文字列を置換して編集します。old_stringが一意に特定できる必要があります。",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "編集するファイルのパス（相対パスを推奨）",
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
      return { success: false, output: "", error: "old_string not found in file" };
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
    return {
      success: true,
      output: `Edited ${filePath}: replaced ${replaceAll ? occurrences : 1} occurrence(s)`,
    };
  },
};
