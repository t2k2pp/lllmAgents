import type { SecurityConfig } from "../config/types.js";
export declare class Sandbox {
    private allowedDirs;
    constructor(config: SecurityConfig);
    /**
     * パスがサンドボックス内かチェック。
     *
     * セキュリティ対策:
     * - symlink解決: fs.realpathSync で実パスに解決後に比較
     * - Windowsパス正規化: 大文字小文字・8.3短縮パス・UNCパスを統一
     * - ディレクトリトラバーサル: path.resolve で ../ を解決
     */
    isPathAllowed(targetPath: string): boolean;
    getAllowedDirs(): string[];
    addAllowedDir(dir: string): void;
}
//# sourceMappingURL=sandbox.d.ts.map