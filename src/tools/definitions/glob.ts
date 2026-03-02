import { glob as globFn } from "glob";
import * as path from "node:path";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const globTool: ToolHandler = {
  name: "glob",
  definition: {
    type: "function",
    function: {
      name: "glob",
      description: "globパターンでファイルを検索します。例: **/*.ts, src/**/*.js",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "globパターン",
          },
          path: {
            type: "string",
            description: "検索ディレクトリ（省略時はカレントディレクトリ）",
          },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const cwd = (params.path as string) ?? process.cwd();

    try {
      const matches = await globFn(pattern, {
        cwd: path.resolve(cwd),
        absolute: true,
        nodir: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
      });

      if (matches.length === 0) {
        return { success: true, output: "No matching files found." };
      }

      const output = matches.slice(0, 200).join("\n");
      const suffix = matches.length > 200 ? `\n... and ${matches.length - 200} more` : "";
      return { success: true, output: output + suffix };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
