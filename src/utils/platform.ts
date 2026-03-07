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
  // Step 0: LLMハルシネーション（トークナイズエラーによるスペース混入）の自動補正
  let sanitizedPath = targetPath.replace(/l\s+llmAgents/g, "lllmAgents");

  // Step 1: path.resolve で相対パス・トラバーサルを解決
  let resolved = path.resolve(sanitizedPath);

  // Step 2: シンボリックリンクを解決（TOCTOU軽減 - 可能な限り実パスを使う）
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // ファイルが存在しない場合: 親ディレクトリを解決して子パスを追加
    // (新規ファイル作成時のチェック)
    const parentDir = path.dirname(resolved);
    const basename = path.basename(resolved);
    try {
      resolved = path.join(fs.realpathSync(parentDir), basename);
    } catch {
      // 親ディレクトリも存在しない場合は path.resolve の結果を使う
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
    return (
      normalizedTarget.startsWith(normalizedPrefix + path.sep) ||
      normalizedTarget === normalizedPrefix
    );
  }
  return (
    targetPath.startsWith(prefix + path.sep) || targetPath === prefix
  );
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
