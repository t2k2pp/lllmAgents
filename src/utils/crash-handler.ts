/**
 * グローバル例外ハンドラとクラッシュログ。
 * 設計: docs/production-readiness.md PR-01
 *
 * 未捕捉例外 / 未処理 Promise rejection で落ちるとき、
 *   (a) セッションの緊急保存 → (b) 端末状態の復元 → (c) クラッシュログ書き出し
 *   → (d) 平易な日本語の終了案内
 * の順で後始末してから明示的に終了する。握りつぶして継続はしない
 * (feedback: silent な欠損の禁止)。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { APP_VERSION, getAppCommit } from "../version.js";

const CRASH_LOG_DIR = path.join(os.homedir(), ".localllm", "logs", "crash");

export interface CrashContext {
  /** 進行中セッションの緊急保存 (同期処理であること) */
  saveSession?: () => void;
  /** セッションID (運用ログ ~/.localllm/logs/ops/<sid>.jsonl への手がかり) */
  sessionId?: string;
}

let context: CrashContext = {};
let installed = false;
let handling = false;
let terminalRestore: (() => void) | null = null;

/** クラッシュ時に使う情報を登録する (起動処理の進行に応じて後から追記できる)。 */
export function setCrashContext(ctx: CrashContext): void {
  context = { ...context, ...ctx };
}

/**
 * 端末の描画状態を戻す処理を登録する。
 * docs/tui-alternate-screen.md §8 — 代替画面の中でスタックを出すと画面ごと消えて
 * 読めなくなるので、スタックを出す前にここを呼んで通常画面へ戻す。
 */
export function setTerminalRestore(fn: () => void): void {
  terminalRestore = fn;
}

/** クラッシュレポート本文を組み立てる (テスト可能な純関数)。 */
export function formatCrashReport(kind: string, err: unknown, ctx: CrashContext = {}): string {
  const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const lines = [
    `LocalLLM Agent crash report`,
    `time: ${new Date().toISOString()}`,
    `version: ${APP_VERSION} (${getAppCommit()})`,
    `node: ${process.version}`,
    `platform: ${process.platform} ${os.release()}`,
    `kind: ${kind}`,
    ctx.sessionId ? `sessionId: ${ctx.sessionId}` : null,
    ctx.sessionId ? `opsLog: ~/.localllm/logs/ops/${ctx.sessionId}.jsonl` : null,
    ``,
    stack,
    ``,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

/** クラッシュログをファイルに書き出し、パスを返す。失敗時は null。 */
export function writeCrashLog(kind: string, err: unknown, dir: string = CRASH_LOG_DIR): string | null {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(dir, `crash-${ts}.log`);
    fs.writeFileSync(filePath, formatCrashReport(kind, err, context), "utf-8");
    return filePath;
  } catch {
    return null;
  }
}

/** raw mode 解除・代替画面からの復帰・カーソル表示・色リセット。REPL がどんな状態でも端末を返せるように。 */
function restoreTerminal(): void {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  } catch {
    /* ignore */
  }
  try {
    // 代替画面を抜けてスクロールバックを書き戻す (§8)。console の差し替えも解除される
    terminalRestore?.();
  } catch {
    /* ignore */
  }
  try {
    process.stdout.write("\x1b[?25h\x1b[0m\n");
  } catch {
    /* ignore */
  }
}

function handleFatal(kind: string, err: unknown): void {
  // 後始末中の二重クラッシュは何もせず即終了 (無限ループ防止)
  if (handling) process.exit(1);
  handling = true;

  let sessionSaved = false;
  try {
    context.saveSession?.();
    sessionSaved = !!context.saveSession;
  } catch {
    /* 保存失敗でも後続の後始末は続ける */
  }

  restoreTerminal();

  const logPath = writeCrashLog(kind, err);

  try {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`\n予期しないエラーで終了します (${kind})。`);
    console.error(stack);
    if (sessionSaved) {
      console.error(`会話は保存済みです。再起動後に --continue で再開できます。`);
    }
    if (logPath) {
      console.error(`詳細ログ: ${logPath}`);
      console.error(`不具合報告の際はこのファイルを添えてください。`);
    }
  } catch {
    /* ignore */
  }

  process.exit(1);
}

/** プロセス全体の未捕捉例外ハンドラを登録する。起動処理の最初に一度だけ呼ぶ。 */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (err) => handleFatal("uncaughtException", err));
  process.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason));
}
