import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const fileWriteTool: ToolHandler = {
  name: "file_write",
  definition: {
    type: "function",
    function: {
      name: "file_write",
      description: "ファイルを作成または上書きします。親ディレクトリは自動作成されます。",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "書き込むファイルの絶対パス",
          },
          content: {
            type: "string",
            description: "書き込む内容",
          },
        },
        required: ["file_path", "content"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = path.resolve(params.file_path as string);
    const content = params.content as string;

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, "utf-8");
    return { success: true, output: `File written: ${filePath}` };
  },
};
