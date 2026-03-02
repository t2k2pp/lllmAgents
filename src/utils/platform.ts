import * as os from "node:os";
import * as path from "node:path";

export const isWindows = process.platform === "win32";
export const isMacOS = process.platform === "darwin";
export const isLinux = process.platform === "linux";

export function normalizePath(p: string): string {
  return path.resolve(p);
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
