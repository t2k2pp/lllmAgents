import { execFileSync } from "node:child_process";

/**
 * アプリのバージョン定数。
 *
 * package.json と二重管理になるが、SEA (単一 exe) 配布では実行時に package.json を
 * 読めないため定数で持つ。リリース時は package.json / CHANGELOG.md と同時に更新し、
 * `v<version>` タグを打つこと (docs/production-readiness.md PR-12)。
 */
export const APP_VERSION = "0.4.0";

/**
 * ビルド時に build-exe.js の esbuild define で実コミットハッシュへ置換される。
 * dev 実行 (tsx) では未定義のまま → getAppCommit() が git から解決する。
 */
declare const __APP_COMMIT__: string;

let cachedCommit: string | null = null;

/**
 * 実行中のコードのコミットハッシュ (short) を返す。
 * 優先順: ビルド時埋め込み → git rev-parse (dev) → "unknown"。
 * 不具合報告で「バージョン+コミット」から中身を特定するための情報 (PR-12)。
 */
export function getAppCommit(): string {
  if (cachedCommit !== null) return cachedCommit;
  if (typeof __APP_COMMIT__ === "string" && __APP_COMMIT__.length > 0) {
    cachedCommit = __APP_COMMIT__;
    return cachedCommit;
  }
  try {
    cachedCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    cachedCommit = "unknown";
  }
  return cachedCommit || "unknown";
}

/** 表示用のバージョン文字列 (例: "v0.4.0 (abc1234)") */
export function getVersionString(): string {
  return `v${APP_VERSION} (${getAppCommit()})`;
}
