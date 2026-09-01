import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * アプリのバージョン定数。
 *
 * package.json を公開版の単一ソースとする。通常のtsx/npm実行はmanifestから読み、
 * SEAではbuild-exe.jsが同じ値を __APP_VERSION__ として埋め込む。
 */
declare const __APP_VERSION__: string;

function readManifestVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest = require("../package.json") as { version?: unknown };
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error(
      `package.json version must be MAJOR.MINOR.PATCH; observed ${JSON.stringify(manifest.version)}. ` +
        "Run npm run validate:version and correct the release metadata.",
    );
  }
  return manifest.version;
}

export const APP_VERSION =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0 ? __APP_VERSION__ : readManifestVersion();

/**
 * ビルド時に build-exe.js の esbuild define で実コミットハッシュへ置換される。
 * dev 実行 (tsx) では未定義のまま → getAppCommit() が git から解決する。
 */
declare const __APP_COMMIT__: string;

let cachedCommit: string | null = null;

function gitCandidates(): string[] {
  const candidates = ["git"];
  if (process.platform !== "win32") return candidates;
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
    if (!root) continue;
    const prefix = root === process.env.LOCALAPPDATA ? win32.join(root, "Programs") : root;
    candidates.push(win32.join(prefix, "Git", "cmd", "git.exe"), win32.join(prefix, "Git", "bin", "git.exe"));
  }
  return [...new Set(candidates)];
}

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
  for (const executable of gitCandidates()) {
    if (executable !== "git" && !existsSync(executable)) continue;
    try {
      const revision = execFileSync(executable, ["rev-parse", "--short", "HEAD"], {
        cwd: APP_ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const dirty = execFileSync(executable, ["status", "--porcelain", "--untracked-files=no"], {
        cwd: APP_ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      cachedCommit = dirty ? `${revision}-dirty` : revision;
      if (cachedCommit) return cachedCommit;
    } catch {
      // PATH候補が無い場合はWindows標準配置を順に試す。
    }
  }
  cachedCommit = "unknown";
  return cachedCommit;
}

/** 表示用: 公開SemVer 3桁とbuild identityを混ぜずに示す。 */
export function getVersionString(): string {
  return `v${APP_VERSION} (build ${getAppCommit()})`;
}
