import * as path from "node:path";
import * as os from "node:os";
import type { ToolHandler, ToolResult } from "../tool-registry.js";
import { loadConfig } from "../../config/config-manager.js";
import { ProcessSandbox } from "../../security/process-sandbox.js";
import { isWindows } from "../../utils/platform.js";
import { detectWsl, resolveWslRouting } from "../../security/wsl.js";

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

    // Windows: bash を WSL 経由で実行しているか（docs/wsl-sandbox-design.md Phase 1）
    let wslSection = "";
    if (isWindows) {
      const det = detectWsl();
      const routing = resolveWslRouting(config.security.wsl, det, true);
      wslSection =
        `\n## WSL 経由実行 (bash ツール / Windows)\n` +
        `- WSL 検出: ${det.available ? `あり (default distro: ${det.defaultDistro ?? "不明"}, ${det.wsl2 ? "WSL2" : "WSL1"})` : "なし"}\n` +
        `- bash の実行先: ${routing.use ? `WSL 経由${routing.distro ? ` (${routing.distro})` : ""}` : `従来経路 (git bash / cmd.exe)${routing.reason ? ` — ${routing.reason}` : ""}`}\n` +
        (det.available && !routing.use
          ? `  （有効化は opt-in: 設定 security.wsl.enabled を "auto" か true に。WSL 側に開発ツールがある前提）\n`
          : "") +
        `- 封じ込め: ${routing.use ? "Phase 1 のため隔離は未適用（Phase 2 で WSL 内サンドボックス連携予定）" : "なし（信頼ベース）"}\n`;
    }

    const output =
      `アクセス可能なディレクトリ（サンドボックス）一覧:\n` +
      dirs.map((d) => `- ${d}`).join("\n") +
      `\n\n※ これらのディレクトリ配下のみが file_read, file_write などの操作対象として許可されています。` +
      osSandboxSection +
      wslSection;

    return { success: true, output };
  },
};
