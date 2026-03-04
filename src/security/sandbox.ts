import * as path from "node:path";
import * as os from "node:os";
import type { SecurityConfig } from "../config/types.js";
import { safeResolvePath, pathStartsWith } from "../utils/platform.js";

export class Sandbox {
  private allowedDirs: string[];

  constructor(config: SecurityConfig) {
    // 許可ディレクトリもセキュアに解決（symlink解決・Windows正規化済み）
    this.allowedDirs = [
      safeResolvePath(process.cwd()),
      safeResolvePath(path.join(os.homedir(), ".localllm")),
      ...config.allowedDirectories.map((d) => safeResolvePath(d)),
    ];
  }

  /**
   * パスがサンドボックス内かチェック。
   *
   * セキュリティ対策:
   * - symlink解決: fs.realpathSync で実パスに解決後に比較
   * - Windowsパス正規化: 大文字小文字・8.3短縮パス・UNCパスを統一
   * - ディレクトリトラバーサル: path.resolve で ../ を解決
   */
  isPathAllowed(targetPath: string): boolean {
    const resolved = safeResolvePath(targetPath);
    return this.allowedDirs.some((dir) => pathStartsWith(resolved, dir));
  }

  getAllowedDirs(): string[] {
    return [...this.allowedDirs];
  }

  addAllowedDir(dir: string): void {
    const resolved = safeResolvePath(dir);
    if (!this.allowedDirs.includes(resolved)) {
      this.allowedDirs.push(resolved);
    }
  }
}
