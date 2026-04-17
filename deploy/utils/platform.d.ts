export declare const isWindows: boolean;
export declare const isMacOS: boolean;
export declare const isLinux: boolean;
export declare function normalizePath(p: string): string;
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
export declare function safeResolvePath(targetPath: string): string;
/**
 * Windows固有のパス正規化
 * - 大文字小文字を統一（小文字化）
 * - 8.3短縮パスは realpathSync で解決済み
 * - UNCパスのプレフィックスを正規化
 */
export declare function normalizeWindowsPath(p: string): string;
/**
 * パスの比較（OS依存のケース感度を考慮）
 * Windows: case-insensitive
 * Linux/macOS: case-sensitive
 */
export declare function pathStartsWith(targetPath: string, prefix: string): boolean;
export declare function getShell(): string;
export declare function getHomedir(): string;
//# sourceMappingURL=platform.d.ts.map