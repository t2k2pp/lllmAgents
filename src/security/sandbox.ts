import * as path from "node:path";
import * as os from "node:os";
import type { SecurityConfig } from "../config/types.js";
import { safeResolvePath, pathStartsWith } from "../utils/platform.js";

export class Sandbox {
  private allowedDirs: string[];
  private deniedPaths: string[];

  constructor(config: SecurityConfig) {
    const home = os.homedir();
    // 許可ディレクトリもセキュアに解決（symlink解決・Windows正規化済み）
    this.allowedDirs = [
      safeResolvePath(process.cwd()),
      safeResolvePath(path.join(home, ".localllm")),
      ...config.allowedDirectories.map((d) => safeResolvePath(d)),
    ];
    // 許可ディレクトリ配下であってもツールからの直接アクセスを禁止する機密パス
    this.deniedPaths = [
      safeResolvePath(path.join(home, ".localllm", "credentials.json")),
      safeResolvePath(path.join(home, ".ssh")),
      safeResolvePath(path.join(home, ".aws")),
      safeResolvePath(path.join(home, ".gnupg")),
      safeResolvePath(path.join(home, ".kube")),
      safeResolvePath(path.join(home, ".aliyun")),
      safeResolvePath(path.join(home, ".config", "gcloud")),
    ];
  }

  /**
   * パスがサンドボックス内かチェック。
   *
   * セキュリティ対策:
   * - symlink解決: fs.realpathSync で実パスに解決後に比較
   * - Windowsパス正規化: 大文字小文字・8.3短縮パス・UNCパスを統一
   * - ディレクトリトラバーサル: path.resolve で ../ を解決
   * - 機密パス遮断: ~/.localllm/credentials.json や ~/.ssh 等の認証情報は allowedDirs 内でも拒否
   */
  isPathAllowed(targetPath: string): boolean {
    const resolved = safeResolvePath(targetPath);
    if (this.deniedPaths.some((denied) => pathStartsWith(resolved, denied))) {
      return false;
    }
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
