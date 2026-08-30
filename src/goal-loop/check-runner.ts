/**
 * Check Runner — goal-loop の「決定的検証ゲート」。
 *
 * 設計思想 (docs/goal-loop-deterministic-check-design.md §2/§4.3):
 * 記事「Write Loops Not Prompts」の核心は、ループがゲートを握り、モデルはサブルーチンになること。
 * そのため検証コマンドは LLM/bash ツール経由でなく、ハーネスが直接 spawn して exit code を取る。
 * これにより「テストが通ったか」は ground-truth (客観) で判定される。
 *
 * shell 解決は src/tools/definitions/bash.ts と同じ契約:
 *   - Windows: git-bash 必須 (無ければ実行前に明示失敗)
 *   - その他: /bin/sh -c
 * cwd は呼び出し元 (= process.cwd()) と一致させ、エージェントの編集と同じ場所で検証する。
 */

import { spawn } from "node:child_process";
import { findGitBash, resolveWindowsBashCommand } from "../tools/definitions/bash.js";

export interface CheckResult {
  /** 実行した検証コマンド */
  command: string;
  /** プロセス exit code (timeout 時は 124, spawn 失敗時は -1) */
  exitCode: number;
  /** exit 0 かつ timeout でない */
  passed: boolean;
  /** stdout 末尾 (切り詰め済み) */
  stdoutTail: string;
  /** stderr 末尾 (切り詰め済み) */
  stderrTail: string;
  /** 実行時間 (ms) */
  durationMs: number;
  /** timeout で打ち切られたか */
  timedOut: boolean;
}

/** stdout/stderr は末尾のみ保持する (失敗の手掛かりは末尾に出ることが多い) */
const TAIL_CHARS = 4000;

function tail(s: string, n: number = TAIL_CHARS): string {
  if (s.length <= n) return s;
  return "…(先頭省略)…\n" + s.slice(s.length - n);
}

interface ResolvedShell {
  shell: string;
  args: string[];
}

export function resolveCheckShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
  bashPath: string | null = platform === "win32" ? findGitBash() : null,
): ResolvedShell {
  if (platform === "win32") {
    return resolveWindowsBashCommand(command, bashPath);
  }
  return { shell: "/bin/sh", args: ["-c", command] };
}

export interface RunCheckOptions {
  cwd?: string;
  /** 既定 120 秒 */
  timeoutMs?: number;
}

/**
 * 検証コマンドを直接実行して結果を返す。LLM を経由しない (= 決定的ゲート)。
 * 例外は投げず、失敗も CheckResult として返す (ループ側で扱いやすくするため)。
 */
export async function runCheck(command: string, opts: RunCheckOptions = {}): Promise<CheckResult> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const { shell, args } = resolveCheckShell(command);
  const start = Date.now();

  const isWindows = process.platform === "win32";

  return new Promise<CheckResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // 非 Windows は detached で自身の process group を作り、timeout 時に group ごと kill する
    // (shell だけ kill すると sleep 等の子が orphan として残り close が遅延するため)。
    const proc = spawn(shell, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWindows,
    });

    const killTree = () => {
      try {
        if (!isWindows && proc.pid) {
          process.kill(-proc.pid, "SIGKILL"); // 負の pid = process group
        } else if (proc.pid) {
          // Windowsではshellだけでなくnpm/node等の孫プロセスも止める。
          // /T でプロセスツリー全体を、/F でタイムアウト時に確実に終了する。
          const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* already exited */
            }
          });
        } else {
          proc.kill("SIGKILL");
        }
      } catch {
        /* already exited */
      }
    };

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode,
        passed: exitCode === 0 && !timedOut,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
        durationMs: Date.now() - start,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // close を待たず即座に確定する (orphan が pipe を握って close が遅延する事故を避ける)
      finish(124);
    }, timeoutMs);

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("error", (err: Error) => {
      stderr += `\n[check-runner spawn error] ${err.message}`;
      finish(-1);
    });
    proc.on("close", (code: number | null) => {
      finish(timedOut ? 124 : (code ?? -1));
    });
  });
}
