import * as path from "node:path";
import * as os from "node:os";
import type { ToolHandler, ToolResult } from "../tool-registry.js";
import { loadConfig } from "../../config/config-manager.js";
import { ProcessSandbox } from "../../security/process-sandbox.js";

export const sandboxInfoTool: ToolHandler = {
  name: "sandbox_info",
  definition: {
    type: "function",
    function: {
      name: "sandbox_info",
      description: "現在自分がアクセス可能なサンドボックス（ディレクトリ）のリストとOSレベルのサンドボックス状態を取得します。存在しないパスや許可されていないパスにアクセスしてエラーになった場合、このツールで自身が操作可能なスコープを確認してください。",
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

    // OS-level サンドボックス状態を取得
    const sbConfig = config.security.processSandbox ?? { enabled: false, level: "none" };
    const sandbox = new ProcessSandbox(sbConfig);
    const avail = sandbox.getAvailability();

    const levelLabels: Record<string, string> = {
      none: "なし（アプリレベルのみ）",
      network: "ネットワーク隔離",
      full: "ネットワーク + ファイルシステム隔離",
    };

    const toolStatus = [
      `bwrap: ${avail.tools.bwrap ? "利用可能" : "未インストール"}`,
      `unshare: ${avail.tools.unshare ? "利用可能" : "未インストール"}`,
      `sandbox-exec: ${avail.tools.sandboxExec ? "利用可能" : "未インストール"}`,
    ].join(", ");

    const osSandboxSection =
      `\n## OS-level プロセスサンドボックス (bash ツール)\n` +
      `- 設定: ${sbConfig.enabled ? "有効" : "無効"} / レベル: ${sbConfig.level}\n` +
      `- 実効レベル: ${levelLabels[avail.effectiveLevel] ?? avail.effectiveLevel}\n` +
      `- プラットフォーム: ${avail.platform}\n` +
      `- ツール状態: ${toolStatus}\n`;

    const output =
      `アクセス可能なディレクトリ（サンドボックス）一覧:\n` +
      dirs.map((d) => `- ${d}`).join("\n") +
      `\n\n※ これらのディレクトリ配下のみが file_read, file_write などの操作対象として許可されています。` +
      osSandboxSection;

    return { success: true, output };
  },
};
