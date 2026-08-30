import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

function gitCandidates(platform = process.platform, env = process.env): string[] {
  const candidates = ["git"];
  if (platform !== "win32") return candidates;

  const roots = [
    env.ProgramFiles ?? "C:\\Program Files",
    env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : null,
  ].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    candidates.push(path.join(root, "Git", "cmd", "git.exe"), path.join(root, "Git", "bin", "git.exe"));
  }
  return [...new Set(candidates)];
}

/** PATHとGit for Windowsの標準install先から、実行できる同一Git capabilityを解決する。 */
export function resolveGitExecutable(): string {
  for (const candidate of gitCandidates()) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 3_000,
        windowsHide: true,
      });
      return candidate;
    } catch {
      // 次の既知install先を試す。同じGit capability以外へは切り替えない。
    }
  }
  throw new Error(
    "Gitが見つかりません。GitをインストールしてPATHへ追加するか、Git for Windowsを標準install先へ導入して再起動してください。",
  );
}

export interface RunGitOptions {
  expectedStatuses?: number[];
  maxBuffer?: number;
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
}

/** shellを介さずGitを実行し、statusと出力上限を共通契約で検証する。 */
export function runGitSync(git: string, args: string[], cwd: string, options: RunGitOptions = {}): string {
  const maxBuffer = options.maxBuffer ?? MAX_GIT_OUTPUT_BYTES;
  const result = spawnSync(git, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
    input: options.input,
    env: options.env,
  });
  if (result.error) {
    const detail = result.error.message.includes("ENOBUFS")
      ? `Git出力が${maxBuffer / 1024 / 1024} MiB上限を超えました。対象を分割してください。`
      : `Gitの起動に失敗しました: ${result.error.message}`;
    throw new Error(detail);
  }
  const expected = options.expectedStatuses ?? [0];
  if (result.status === null || !expected.includes(result.status)) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(detail || `Gitがexit ${result.status ?? "unknown"}で失敗しました: git ${args.join(" ")}`);
  }
  return result.stdout;
}
