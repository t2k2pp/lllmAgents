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

/**
 * P3-B: 破壊的なコマンドを検出して、 実行前に git status のスナップショットを
 * 取得する。 docs/agent-loop-efficiency-review.md §4.7 参照。
 *
 * 対象パターン:
 * - git checkout -- <path> / git checkout . (作業ツリー破棄)
 * - git reset --hard
 * - git clean -fd / -fdx (untracked 削除)
 * - rm -rf / rm -fr
 * - find ... -delete
 *
 * 観測ログ (株アプリ実装、 2026-05-06 セッション T86) で、 git checkout が失敗し
 * 作業ツリーが意図せぬ状態で残り、 同じ編集を 6 回やり直す事象が発生した。
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bgit\s+checkout\s+(--\s|\.\s|\.$|--$)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*[df][a-z]*\b/,
  /\brm\s+-[rR][fF]?\s|\brm\s+-[fF][rR]?\s/,
  /\bfind\b[^|;&]*-delete\b/,
];
function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}
function captureGitStatusSnapshot(): string {
  try {
    const out = execFileSync("git", ["status", "--short"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    // git リポジトリ外、 or git 未インストール → スナップショットなしで続行
    return "";
  }
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
      description:
        "シェルコマンドを実行する (Windows では git bash、なければ cmd.exe)。\n" +
        "[使うべき場面] (1) ファイル探索 (find, ls -la), " +
        "(2) git/npm/python 等のツール実行, " +
        "(3) 専用ツールが無い操作 (ファイル移動 mv, 圧縮 tar, etc.)。\n" +
        "[使うべきでない] (1) ファイル中身確認 → file_read。 " +
        "(2) ファイル一覧 → glob。 " +
        "(3) 中身検索 → grep。 " +
        "(4) ファイル編集 → file_edit/file_write (sed -i は不可視で扱いづらい)。\n" +
        "[よくある誤用] (a) Windows で cmd 構文を期待 → git bash なので Unix 構文。 " +
        "(b) パイプの中で対話入力を要するコマンド → 使わない。 " +
        "(c) 長時間実行コマンド → timeout を増やすか run_in_background を検討。\n" +
        "[破壊的コマンドの作法] git checkout -- / git reset --hard / git clean -fd / rm -rf / find -delete を実行する前に必ず " +
        "git status --short で状態を確認し、 不要な作業を巻き込まないか検証してから打つこと。 ハーネスは破壊的コマンド検出時、 " +
        "事前 git status を取得して結果先頭に添付する (= 巻き込み事故を可視化)。\n" +
        "[副次情報] 成功時に exitCode/durationMs/stdoutBytes を末尾に付与。",
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
      killProcessTree(currentProcess);
      currentProcess = null;
    }
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command as string;
    const timeout = (params.timeout as number) ?? DEFAULT_TIMEOUT;

    // P3-B: 破壊的コマンド検出 → 事前 git status スナップショットを保持
    const destructive = isDestructiveCommand(command);
    const preflightStatus = destructive ? captureGitStatusSnapshot() : "";

    // OS-level サンドボックスラップ
    let shell: string;
    let shellArgs: string[];
    let cleanup: (() => void) | undefined;

    if (isWindows) {
      // Windows ネイティブ: git bash (無ければ cmd.exe)。 OS レベルの封じ込めは無し。
      // 封じ込めが必要な場合は WSL2 の中で本アプリを起動する。 その時は platform=linux と
      // なり、 下の processSandbox 経路がそのまま効く (docs/wsl-sandbox-design.md §3・§4.6)。
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

      const startMs = Date.now();
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
        // Phase 5-C2: 副次情報の標準同梱 (exitCode/duration/bytes)
        const durationMs = Date.now() - startMs;
        const meta = `\n[bash] exitCode=${code ?? "?"} | duration=${durationMs}ms | stdout=${stdout.length}B | stderr=${stderr.length}B`;
        // P3-B: 破壊的コマンドの場合、 事前 git status を結果先頭に添付。
        // これによりモデルは「どのファイルが破棄されたか」 を即座に把握でき、
        // T86 (git checkout 失敗 → 同じ編集 6 回やり直し) のような事故が防げる。
        let prefix = "";
        if (destructive) {
          prefix = preflightStatus
            ? `[P3-B] 破壊的コマンド検出。 実行前の git status:\n${preflightStatus}\n[ハーネス] ` +
              `この破壊操作で巻き込まれた可能性のあるファイルが上記です。 必要なら別途 stash で退避してから再実行を検討。\n---\n`
            : `[P3-B] 破壊的コマンド検出 (git リポジトリ外、 または git 未インストール)。 ロールバック失敗時の復旧手段を確保していますか?\n---\n`;
        }
        if (code === 0) {
          return { success: true, output: prefix + truncated + meta };
        }
        return { success: false, output: prefix + truncated + meta, error: `Exit code: ${code}` };
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

      // Ctrl+Cでのabort: agent-loop側のabortableIteratorが
      // _aborted=trueにした後、repl.tsのsigintHandlerがkillRunningProcess()を呼ぶ。
      // killProcessTree()でプロセスツリーごと殺す。

      // 独自タイムアウト: spawn の timeout は Windows で効かないことがあるため
      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          killProcessTree(proc);
          done({ success: false, output: stdout.trim(), error: `Timeout: command exceeded ${timeout}ms` });
        }
      }, timeout);
    });
  },
};

/**
 * プロセスツリーごと強制終了する。
 * Windowsでは proc.kill() だと直接の子プロセスしか終了せず、
 * 孫プロセス（bash→python→pygame等）が孤立して残る。
 * taskkill /T /F でプロセスツリー全体を殺す。
 */
function killProcessTree(proc: ChildProcess): void {
  if (proc.killed) return;
  const pid = proc.pid;
  if (pid && isWindows) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        timeout: 5000,
        stdio: "ignore",
      });
      return;
    } catch {
      // taskkill が失敗した場合はフォールバック
    }
  }
  // 非Windows or taskkill失敗時: 通常のkill
  try { proc.kill(); } catch { /* ignore */ }
}
