import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { isWindows } from "../../utils/platform.js";
import { ProcessSandbox } from "../../security/process-sandbox.js";
import { loadConfig } from "../../config/config-manager.js";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes

let streamOutputEnabled = false;

/** bash ツール用のプロセスサンドボックスインスタンス（初回 execute 時に遅延初期化） */
let processSandbox: ProcessSandbox | null = null;

function getProcessSandbox(): ProcessSandbox {
  if (!processSandbox) {
    const config = loadConfig();
    const sbConfig = config.security.processSandbox ?? { enabled: false, level: "none" };
    processSandbox = new ProcessSandbox(sbConfig);
  }
  return processSandbox;
}

/** config 変更時にサンドボックスインスタンスをリセットする（テスト・ウィザード用） */
export function resetProcessSandboxCache(): void {
  processSandbox = null;
}

interface BashToolHandler extends ToolHandler {
  setStreamOutput(enabled: boolean): void;
}

export const bashTool: BashToolHandler = {
  name: "bash",
  definition: {
    type: "function",
    function: {
      name: "bash",
      description: "シェルコマンドを実行します。コマンドの結果（stdout/stderr）を返します。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "実行するシェルコマンド",
          },
          timeout: {
            type: "number",
            description: "タイムアウト（ミリ秒）。デフォルト: 120000",
          },
        },
        required: ["command"],
      },
    },
  },
  setStreamOutput(enabled: boolean): void {
    streamOutputEnabled = enabled;
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command as string;
    const timeout = (params.timeout as number) ?? DEFAULT_TIMEOUT;

    // OS-level サンドボックスラップ
    let shell: string;
    let shellArgs: string[];
    let cleanup: (() => void) | undefined;

    if (isWindows) {
      // Windows は未サポート（アプリレベルのみ）
      shell = "cmd.exe";
      shellArgs = ["/c", command];
    } else {
      const sandbox = getProcessSandbox();
      if (sandbox.isActive()) {
        const config = loadConfig();
        const allowedWriteDirs = [
          process.cwd(),
          path.join(os.homedir(), ".localllm"),
          ...config.security.allowedDirectories,
        ];
        const wrapped = sandbox.wrapCommand(command, allowedWriteDirs);
        shell = wrapped.shell;
        shellArgs = wrapped.args;
        cleanup = wrapped.cleanup;
      } else {
        shell = "/bin/sh";
        shellArgs = ["-c", command];
      }
    }

    return new Promise((resolve) => {
      const proc = spawn(shell, shellArgs, {
        cwd: process.cwd(),
        timeout,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        if (streamOutputEnabled) {
          process.stdout.write(text);
        }
      });
      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        if (streamOutputEnabled) {
          process.stderr.write(text);
        }
      });

      proc.on("close", (code) => {
        cleanup?.();
        const output = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim();
        const truncated = output.length > 30000 ? output.slice(0, 30000) + "\n... (truncated)" : output;

        if (code === 0) {
          resolve({ success: true, output: truncated });
        } else {
          resolve({ success: false, output: truncated, error: `Exit code: ${code}` });
        }
      });

      proc.on("error", (err) => {
        cleanup?.();
        resolve({ success: false, output: "", error: err.message });
      });
    });
  },
};
