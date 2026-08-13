/**
 * OutputRouter — すべての標準出力を ScreenManager に集約する。
 * 設計: docs/tui-alternate-screen.md §3.3
 *
 * `console.log` の呼び出しは repl.ts だけで 1,000 箇所を超える。呼び出し側を書き換えるのは
 * 変更量に見合わず、書き換え漏れが 1 箇所でもあると画面が壊れる。そこで
 * `console` と `process.stdout.write` を起動時に 1 回だけ差し替え、まだ見ぬコードも
 * 自動的に経路に乗るようにする。
 *
 * - `console.error` は stderr のまま触らない。パイプで `2>` に落とす運用を壊さないため
 * - 元の関数は保持し、`uninstallOutputRouter()` で必ず戻せるようにする (§11 のリスク対策)
 */
import { format } from "node:util";
import { screen, type ScreenManager } from "./screen-manager.js";

interface OriginalHandles {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  stdoutWrite: typeof process.stdout.write;
}

let original: OriginalHandles | undefined;

/** チャンク (string | Uint8Array) を文字列へ寄せる */
function toText(chunk: unknown, encoding: BufferEncoding): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding);
  return String(chunk);
}

/**
 * `console` / `process.stdout.write` を ScreenManager 経由に差し替える。
 * 起動直後に 1 回だけ呼ぶこと。二重呼び出しは無視する。
 */
export function installOutputRouter(target: ScreenManager = screen): void {
  if (original) return;

  original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    stdoutWrite: process.stdout.write,
  };

  const emit = (args: unknown[]): void => {
    target.write(`${format(...args)}\n`);
  };

  console.log = (...args: unknown[]) => emit(args);
  console.info = (...args: unknown[]) => emit(args);
  console.warn = (...args: unknown[]) => emit(args);

  const patched = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    // write(chunk, cb) と write(chunk, encoding, cb) の両方の呼ばれ方がある
    const cb = typeof encoding === "function" ? encoding : typeof callback === "function" ? callback : undefined;
    const enc = (typeof encoding === "string" ? encoding : "utf8") as BufferEncoding;
    target.write(toText(chunk, enc));
    // 書き込み完了コールバックは本物の stream と同じく後で呼ぶ
    if (cb) process.nextTick(cb as () => void);
    // 背圧なし (ScreenManager が同期的に受け取り切っている)
    return true;
  };
  process.stdout.write = patched as typeof process.stdout.write;
}

/** 差し替えを元に戻す。終了処理・テストの後始末で呼ぶ。 */
export function uninstallOutputRouter(): void {
  if (!original) return;
  console.log = original.log;
  console.info = original.info;
  console.warn = original.warn;
  process.stdout.write = original.stdoutWrite;
  original = undefined;
}

/** 差し替え済みか */
export function isOutputRouterInstalled(): boolean {
  return original !== undefined;
}
