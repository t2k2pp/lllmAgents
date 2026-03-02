import * as path from "node:path";
import * as os from "node:os";
import type { SecurityConfig } from "../config/types.js";

export class Sandbox {
  private allowedDirs: string[];

  constructor(config: SecurityConfig) {
    this.allowedDirs = [
      path.resolve(process.cwd()),
      path.resolve(os.homedir(), ".localllm"),
      ...config.allowedDirectories.map((d) => path.resolve(d)),
    ];
  }

  isPathAllowed(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    return this.allowedDirs.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
  }

  getAllowedDirs(): string[] {
    return [...this.allowedDirs];
  }

  addAllowedDir(dir: string): void {
    const resolved = path.resolve(dir);
    if (!this.allowedDirs.includes(resolved)) {
      this.allowedDirs.push(resolved);
    }
  }
}
