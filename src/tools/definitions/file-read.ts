import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const fileReadTool: ToolHandler = {
  name: "file_read",
  definition: {
    type: "function",
    function: {
      name: "file_read",
      description: "ファイルの内容を読み取ります。行番号付きで返します。",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "読み取るファイルのパス（相対パスを推奨）",
          },
          offset: {
            type: "number",
            description: "読み取り開始行番号 (1-based)。省略時は先頭から。",
          },
          limit: {
            type: "number",
            description: "読み取る行数。省略時は最大2000行。",
          },
        },
        required: ["file_path"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = path.resolve(params.file_path as string);
    const offset = (params.offset as number) ?? 1;
    const limit = (params.limit as number) ?? 2000;

    if (!fs.existsSync(filePath)) {
      return { success: false, output: "", error: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return { success: false, output: "", error: `Path is a directory: ${filePath}` };
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const startIdx = Math.max(0, offset - 1);
    const endIdx = Math.min(lines.length, startIdx + limit);
    const selected = lines.slice(startIdx, endIdx);

    const numbered = selected
      .map((line, i) => {
        const lineNum = String(startIdx + i + 1).padStart(5, " ");
        const truncated = line.length > 2000 ? line.slice(0, 2000) + "..." : line;
        return `${lineNum}\t${truncated}`;
      })
      .join("\n");

    return { success: true, output: numbered };
  },
};
