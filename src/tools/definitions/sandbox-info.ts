import * as path from "node:path";
import * as os from "node:os";
import type { ToolHandler, ToolResult } from "../tool-registry.js";
import { loadConfig } from "../../config/config-manager.js";

export const sandboxInfoTool: ToolHandler = {
  name: "sandbox_info",
  definition: {
    type: "function",
    function: {
      name: "sandbox_info",
      description: "現在自分がアクセス可能なサンドボックス（ディレクトリ）のリストを取得します。存在しないパスや許可されていないパスにアクセスしてエラーになった場合、このツールで自身が操作可能なスコープを確認してください。",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  async execute(): Promise<ToolResult> {
    const config = loadConfig();
    const dirs = [
      process.cwd(),
      path.join(os.homedir(), ".localllm"),
      ...config.security.allowedDirectories,
    ];
    
    const output = `アクセス可能なディレクトリ（サンドボックス）一覧:\n` + 
      dirs.map(d => `- ${d}`).join("\n") +
      `\n\n※ これらのディレクトリ配下のみが file_read, file_write などの操作対象として許可されています。`;

    return { success: true, output };
  },
};
