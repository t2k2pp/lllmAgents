import { spawn, execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { isWindows, isMacOS } from "../../utils/platform.js";
import { getActiveProcessSandbox } from "../../security/active-sandbox.js";
import { getSandboxProxy } from "../../security/sandbox-proxy.js";
import { isDestructiveCommand } from "../../security/destructive-commands.js";
import { loadConfig } from "../../config/config-manager.js";
import { Utf8ChunkDecoder } from "../../utils/utf8-chunk-decoder.js";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes

/** Windows で git bash のパスを探す。見つからなければ null */
export function findGitBash(): string | null {
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
  } catch {
    /* ignore */
  }
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
    (_match, drive: string, rest: string) => `${drive}:/${rest.replace(/\\/g, "/")}`,
  );
}

/**
 * Windowsでもbash toolのPOSIX意味論を固定する。cmd.exeは引用符・pipe・環境変数・組込みが
 * 異なるため、自動置換すると同じcommandが別の操作になる。Git Bashが無ければ明示失敗する。
 */
export function resolveWindowsBashCommand(command: string, bashPath: string | null): { shell: string; args: string[] } {
  if (!bashPath) {
    throw new Error(
      "bash toolに必要なGit Bashが見つかりません。Git for Windowsをインストールして再起動してください。" +
        " コマンドの意味が変わるためcmd.exeでは実行しません。",
    );
  }
  return { shell: bashPath, args: ["-c", convertWindowsPaths(command)] };
}

let streamOutputEnabled = false;

// プロセスサンドボックスは src/security/active-sandbox.ts の単一ソースを参照する
// （確認自動許可の判定 containment.ts と同一インスタンス・同一設定を見るため）。

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
// 破壊的コマンド判定は src/security/destructive-commands.ts の正典リストに集約
// （permission-manager の自動許可ゲートと同一ソース。 乖離防止＝Phase 3 レビュー対応）。
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
        "シェルコマンドを実行する (Windows では Git Bash が必須。見つからなければ実行前に失敗する)。\n" +
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

    // OS-level サンドボックスラップ
    let shell: string;
    let shellArgs: string[];
    let cleanup: (() => void) | undefined;
    // Phase 2b-1: macOS + fs レベルで在プロセスプロキシ経由のネット allowlist を強制する際の port
    let proxyPort: number | undefined;
    let socketPath: string | undefined;
    let failClosedNet = false;
    let proxyStartError: string | undefined;

    if (isWindows) {
      // Windows ネイティブ: Git Bash必須。 OS レベルの封じ込めは無し。
      // 封じ込めが必要な場合は WSL2 の中で本アプリを起動する。 その時は platform=linux と
      // なり、 下の processSandbox 経路がそのまま効く (docs/wsl-sandbox-design.md §3・§4.6)。
      try {
        const resolved = resolveWindowsBashCommand(command, getGitBash());
        shell = resolved.shell;
        shellArgs = resolved.args;
      } catch (error) {
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          errorKind: "permanent",
        };
      }
    } else {
      const sandbox = getActiveProcessSandbox();
      const readinessError = sandbox.getReadinessError();
      if (readinessError) {
        return { success: false, output: "", error: readinessError, errorKind: "permanent" };
      }
      if (sandbox.isActive()) {
        const config = loadConfig();
        // ~/.localllm は bash の書込許可に含めない（自アプリの config/API キー/セッションの
        // 改ざんを防ぐ。 読取も機密として遮断＝process-sandbox の computeSecretProtection）。
        const allowedWriteDirs = [process.cwd(), ...config.security.allowedDirectories];
        // fs レベルなら在プロセスプロキシを起動し、 ネットを allowlist 経由に閉じる。
        //  - macOS (2b-1): Seatbelt が 127.0.0.1:proxyPort のみ許可。直結は遮断。
        //  - Linux/WSL2 (2b-2): bwrap --unshare-net + unix ソケット + socat ブリッジ。
        const proxy = getSandboxProxy();
        const effLevel = sandbox.getEffectiveLevel();
        if (isMacOS && proxy && effLevel === "fs") {
          try {
            proxyPort = await proxy.ensureStarted();
          } catch (e) {
            // 起動失敗でも「ネット全開」には落ちない（fail-closed）。proxyPort 未設定 →
            // Seatbelt は localhost:port 許可を出さず全ネット遮断になる。沈黙で詰まらせない。
            proxyPort = undefined;
            proxyStartError = e instanceof Error ? e.message : String(e);
          }
        } else if (!isWindows && !isMacOS && proxy && effLevel === "fs" && sandbox.canEnforceLinuxNetAllowlist()) {
          try {
            proxyPort = await proxy.ensureStarted(); // socat が名前空間内で使うポート番号
            socketPath = path.join(os.tmpdir(), `lllm-proxy-${process.pid}.sock`);
            await proxy.ensureUnixSocket(socketPath);
          } catch (e) {
            // ブリッジ構築失敗時は fail-closed（ネット全遮断）に倒す。全開に落とさない。
            proxyPort = undefined;
            socketPath = undefined;
            failClosedNet = true;
            proxyStartError = e instanceof Error ? e.message : String(e);
          }
        }
        const wrapped = sandbox.wrapCommand(command, allowedWriteDirs, proxyPort, socketPath, failClosedNet);
        shell = wrapped.shell;
        shellArgs = wrapped.args;
        cleanup = wrapped.cleanup;
      } else {
        shell = "/bin/sh";
        shellArgs = ["-c", command];
      }
    }

    // P3-B: 実行可能性を確認した後でのみ、破壊的コマンドの事前git statusを取得する。
    const destructive = isDestructiveCommand(command);
    const preflightStatus = destructive ? captureGitStatusSnapshot() : "";

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
      // Phase 2b-1: プロキシ経由にする場合は子プロセスへ HTTP(S)_PROXY を注入
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      if (proxyPort) {
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;
        childEnv.HTTP_PROXY = proxyUrl;
        childEnv.HTTPS_PROXY = proxyUrl;
        childEnv.http_proxy = proxyUrl;
        childEnv.https_proxy = proxyUrl;
        // 親シェルの NO_PROXY が残るとプロキシをバイパスし allowlist が無効化されるため必ず除去。
        delete childEnv.NO_PROXY;
        delete childEnv.no_proxy;
        delete childEnv.ALL_PROXY;
        delete childEnv.all_proxy;
      }
      const proc = spawn(shell, shellArgs, {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      currentProcess = proc;

      let stdout = "";
      let stderr = "";
      const stdoutDecoder = new Utf8ChunkDecoder();
      const stderrDecoder = new Utf8ChunkDecoder();
      let streamsFinalized = false;

      const appendStdout = (text: string): void => {
        stdout += text;
        if (streamOutputEnabled && text) process.stdout.write(text);
      };
      const appendStderr = (text: string): void => {
        stderr += text;
        if (streamOutputEnabled && text) process.stderr.write(text);
      };
      const finalizeStreams = (): void => {
        if (streamsFinalized) return;
        streamsFinalized = true;
        appendStdout(stdoutDecoder.end());
        appendStderr(stderrDecoder.end());
      };

      proc.stdout.on("data", (data: Buffer) => {
        appendStdout(stdoutDecoder.write(data));
      });
      proc.stderr.on("data", (data: Buffer) => {
        appendStderr(stderrDecoder.write(data));
      });

      const buildResult = (code: number | null): ToolResult => {
        finalizeStreams();
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
        const stdoutBytes = Buffer.byteLength(stdout, "utf8");
        const stderrBytes = Buffer.byteLength(stderr, "utf8");
        const meta = `\n[bash] exitCode=${code ?? "?"} | duration=${durationMs}ms | stdout=${stdoutBytes}B | stderr=${stderrBytes}B`;
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
        if (proxyStartError) {
          prefix =
            `[sandbox] ネット allowlist プロキシの起動に失敗したため、 fs サンドボックスは` +
            `フェイルクローズで全ネットワークを遮断しています (原因: ${proxyStartError})。` +
            `通信が必要な場合は /sandbox off で一時解除するか、 プロキシ起動エラーを解消してください。\n---\n` +
            prefix;
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
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
}
