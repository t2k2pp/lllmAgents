import * as path from "node:path";
import * as os from "node:os";
import type { ToolHandler, ToolResult } from "../tool-registry.js";
import { loadConfig } from "../../config/config-manager.js";
import { getActiveProcessSandbox } from "../../security/active-sandbox.js";
import { isWindows } from "../../utils/platform.js";
import { detectWsl } from "../../security/wsl.js";
import { isBashNetworkContained } from "../../security/containment.js";
import { getSandboxProxy } from "../../security/sandbox-proxy.js";

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

    // OS-level サンドボックス状態を取得（bash 実行・確認自動許可と同一の単一ソースを参照）
    const sbConfig = config.security.processSandbox ?? { enabled: false, level: "none" };
    const avail = getActiveProcessSandbox().getAvailability();

    const levelLabels: Record<string, string> = {
      none: "なし（アプリレベルのみ）",
      fs: "ファイルシステム書込隔離",
      network: "ネットワーク隔離",
      full: "ネットワーク + ファイルシステム隔離",
    };

    // ネットの実態を OS/レベル別に正直に出す（LLM が「fs だから安全」と誤認しないため）。
    const netNote = (() => {
      if (avail.effectiveLevel === "fs") {
        if (avail.netAllowlistEnforceable) return "allowlist 経由のみ許可（未許可ドメインは要承認）";
        // Linux で socat/ip 不足 → 強制不可
        return "全開（allowlist 未強制。 socat と ip が必要。 未導入のため外部送信を防げない）";
      }
      if (avail.effectiveLevel === "network" || avail.effectiveLevel === "full") {
        return "全遮断（allowlist 非適用）";
      }
      return "制限なし";
    })();

    const toolStatus = [
      `bwrap: ${avail.tools.bwrap ? "利用可能" : "未インストール"}`,
      `unshare: ${avail.tools.unshare ? "利用可能" : "未インストール"}`,
      `sandbox-exec: ${avail.tools.sandboxExec ? "利用可能" : "未インストール"}`,
    ].join(", ");

    const osSandboxSection =
      `\n## OS-level プロセスサンドボックス (bash ツール)\n` +
      `- 設定: ${sbConfig.enabled ? "有効" : "無効"} / レベル: ${sbConfig.level}\n` +
      `- 実効レベル: ${levelLabels[avail.effectiveLevel] ?? avail.effectiveLevel}\n` +
      `- ネットワーク: ${netNote}\n` +
      `- プラットフォーム: ${avail.platform}\n` +
      `- ツール状態: ${toolStatus}\n` +
      ((avail.effectiveLevel === "fs" || avail.effectiveLevel === "full")
        ? `- 機密読取ブロック: ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.docker, ~/.config/gcloud は読み取り不可\n`
        : "") +
      `- bash 確認自動許可: ${isBashNetworkContained() ? "有効（封じ込め下。 破壊的操作・allowlist 外通信は確認）" : "無効"}\n` +
      (() => {
        const relayed = getSandboxProxy()?.getRelayedHosts() ?? [];
        return relayed.length ? `- 中継した宛先(今セッション): ${relayed.join(", ")}\n` : "";
      })();

    // Windows ネイティブ: OS 封じ込めは非対応。 封じ込めが必要なら WSL2 の中でアプリを
    // 起動する (その時は platform=linux となり上記 processSandbox が効く)。
    // docs/wsl-sandbox-design.md §3・§4.6。
    let wslSection = "";
    if (isWindows) {
      const det = detectWsl();
      wslSection =
        `\n## Windows ネイティブの封じ込め (bash ツール)\n` +
        `- OS レベルの封じ込め: 非対応 (bash は git bash で実行)\n` +
        (det.available
          ? `- WSL2 検出: あり (${det.defaultDistro ?? "不明"}${det.wsl2 ? "" : " / WSL1"})\n` +
            `  → 封じ込めが必要なら WSL2 の中で本アプリを起動してください。 Linux として processSandbox (bwrap) が効きます。\n`
          : `- WSL2 検出: なし\n  → 封じ込めには WSL2 を導入し、 その中で本アプリを起動してください。\n`);
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
