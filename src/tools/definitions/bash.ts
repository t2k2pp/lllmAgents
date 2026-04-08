import { spawn, execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { isWindows } from "../../utils/platform.js";
import { ProcessSandbox } from "../../security/process-sandbox.js";
import { loadConfig } from "../../config/config-manager.js";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes

/** Windows で git bash のパスを探す。見つからなければ null */
function findGitBash(): string | null {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // PATH から探す
  try {
    const result = execFileSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 3000 });
    const first = result.trim().split("\n")[0]?.trim();
    if (first && fs.existsSync(first)) return first;
  } catch { /* ignore */ }
  return null;
}

/** Windows で git bash のパスをキャッシュ */
let gitBashPath: string | null | undefined;
function getGitBash(): string | null {
  if (gitBashPath === undefined) {
    gitBashPath = findGitBash();
  }
  return gitBashPath;
}

/**
 * コマンド文字列中のWindowsスタイルパス（バックスラッシュ区切り）をUnixスタイル（スラッシュ）に変換する。
 * git bash では \ がエスケープ文字として解釈されるため、パス区切りとしての \ を / に変換する必要がある。
 *
 * 対象: ドライブレター付きパス (C:\Users\...) およびUNCパス (\\server\share)
 * 非対象: エスケープシーケンス (\n, \t 等)、正規表現中の \
 */
function convertWindowsPaths(command: string): string {
  // ドライブレター付きパス: C:\Users\... → C:/Users/...
  // 後ろにパス構成文字が続くバックスラッシュのみ変換
  return command.replace(
    /([A-Za-z]):\\([\w.\-\\/ ]+)/g,
    (_match, drive: string, rest: string) => `${drive}:/${rest.replace(/\\/g, '/')}`
  );
}

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
  /** 現在実行中の子プロセスを強制終了する（Ctrl+C用） */
  killRunningProcess(): void;
}

/** 現在実行中の子プロセス（abort用） */
import type { ChildProcess } from "node:child_process";
let currentProcess: ChildProcess | null = null;

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
  killRunningProcess(): void {
    if (currentProcess && !currentProcess.killed) {
      currentProcess.kill();
      currentProcess = null;
    }
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command as string;
    const timeout = (params.timeout as number) ?? DEFAULT_TIMEOUT;

    // OS-level サンドボックスラップ
    let shell: string;
    let shellArgs: string[];
    let cleanup: (() => void) | undefined;

    if (isWindows) {
      const bash = getGitBash();
      if (bash) {
        // git bash を使用（Unix構文対応）
        // Windowsパスのバックスラッシュをスラッシュに変換（bash のエスケープ解釈を防止）
        shell = bash;
        shellArgs = ["-c", convertWindowsPaths(command)];
      } else {
        // git bash が見つからない場合は cmd.exe フォールバック
        shell = "cmd.exe";
        shellArgs = ["/c", command];
      }
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
      let resolved = false;
      const done = (result: ToolResult) => {
        if (resolved) return;
        resolved = true;
        currentProcess = null;
        cleanup?.();
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve(result);
      };

      const proc = spawn(shell, shellArgs, {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      currentProcess = proc;

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

      const buildResult = (code: number | null): ToolResult => {
        let stderrText = stderr;
        if (isWindows && stderrText && /[\ufffd]/.test(stderrText)) {
          stderrText += "\n(文字化けしたエラーメッセージはShift-JISエンコードの可能性があります)";
        }
        if (isWindows && stderrText) {
          if (/is not recognized|認識されていません|内部コマンドまたは外部コマンド/.test(stderrText)) {
            stderrText += "\n(ヒント: ファイル内容の確認には file_read ツールを使用してください)";
          }
        }
        const output = (stdout + (stderrText ? `\nSTDERR:\n${stderrText}` : "")).trim();
        const truncated = output.length > 30000 ? output.slice(0, 30000) + "\n... (truncated)" : output;
        if (code === 0) {
          return { success: true, output: truncated };
        }
        return { success: false, output: truncated, error: `Exit code: ${code}` };
      };

      // close と exit の両方を監視（Windowsでcloseが発火しないケース対策）
      proc.on("close", (code) => done(buildResult(code)));
      proc.on("exit", (code) => {
        // close が先に来ることが多いが、来なかった場合のフォールバック
        // ストリームが閉じていなくても 500ms 後に強制解決
        setTimeout(() => done(buildResult(code)), 500);
      });

      proc.on("error", (err) => {
        done({ success: false, output: "", error: err.message });
      });

      // 独自タイムアウト: spawn の timeout は Windows で効かないことがあるため
      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          try { proc.kill(); } catch { /* ignore */ }
          done({ success: false, output: stdout.trim(), error: `Timeout: command exceeded ${timeout}ms` });
        }
      }, timeout);
    });
  },
};
