import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const isWindows = process.platform === "win32";
export const isMacOS = process.platform === "darwin";
export const isLinux = process.platform === "linux";

export function normalizePath(p: string): string {
  return path.resolve(p);
}

/**
 * セキュアなパス解決。サンドボックスチェック用。
 *
 * 対処するリスク:
 * - Windows: 大文字小文字の不一致、8.3短縮パス（PROGRA~1等）、UNCパス
 * - Linux/macOS: シンボリックリンクによるサンドボックス回避
 * - 共通: ディレクトリトラバーサル（../, ./)
 *
 * @param targetPath 検証対象のパス
 * @returns 正規化済みの実パス（シンボリックリンク解決済み）
 */
export function safeResolvePath(targetPath: string): string {
  // Step 1: path.resolve で相対パス・トラバーサルを解決
  let resolved = path.resolve(targetPath);

  // Step 2: シンボリックリンクを解決（TOCTOU軽減 - 可能な限り実パスを使う）
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // ファイルや親ディレクトリが存在しない場合: 存在する最深の祖先ディレクトリまで遡って realpathSync で解決し、
    // 残りの子パスを結合する（macOS の /var → /private/var 等で複数階層下の未作成パスでも一致させるため）
    const tailSegments: string[] = [];
    let current = resolved;
    while (true) {
      const parentDir = path.dirname(current);
      if (parentDir === current) break;
      tailSegments.unshift(path.basename(current));
      current = parentDir;
      try {
        resolved = path.join(fs.realpathSync(current), ...tailSegments);
        break;
      } catch {
        // さらに上の親ディレクトリへ遡る
      }
    }
  }

  // Step 3: Windows固有の正規化
  if (isWindows) {
    resolved = normalizeWindowsPath(resolved);
  }

  return resolved;
}

/**
 * Windows固有のパス正規化
 * - 大文字小文字を統一（小文字化）
 * - 8.3短縮パスは realpathSync で解決済み
 * - UNCパスのプレフィックスを正規化
 */
export function normalizeWindowsPath(p: string): string {
  // UNCパス正規化: \\?\, \\.\, // 等の変形を統一
  let normalized = p;

  // \\?\ プレフィックス（拡張長パス）を除去
  if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
  }
  // \\.\ プレフィックス（デバイスパス）を除去
  if (normalized.startsWith("\\\\.\\")) {
    normalized = normalized.slice(4);
  }

  // ドライブレターを小文字化（C:→c:）してケースインセンシティブ比較を統一
  normalized = normalized.toLowerCase();

  // パスセパレータを統一
  normalized = normalized.replace(/\//g, "\\");

  return normalized;
}

/**
 * パスの比較（OS依存のケース感度を考慮）
 * Windows: case-insensitive
 * Linux/macOS: case-sensitive
 */
export function pathStartsWith(targetPath: string, prefix: string): boolean {
  if (isWindows) {
    const normalizedTarget = normalizeWindowsPath(targetPath);
    const normalizedPrefix = normalizeWindowsPath(prefix);
    return normalizedTarget.startsWith(normalizedPrefix + path.sep) || normalizedTarget === normalizedPrefix;
  }
  return targetPath.startsWith(prefix + path.sep) || targetPath === prefix;
}

export function getShell(): string {
  if (isWindows) {
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

export function getHomedir(): string {
  return os.homedir();
}
