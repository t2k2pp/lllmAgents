import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** PATHに加え、Windowsの標準Git配置も候補にする。 */
export function gitExecutableCandidates(env = process.env, platform = process.platform) {
  const candidates = ["git"];
  if (platform !== "win32") return candidates;
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
    if (!root) continue;
    candidates.push(join(root, root === env.LOCALAPPDATA ? "Programs" : "", "Git", "cmd", "git.exe"));
    candidates.push(join(root, root === env.LOCALAPPDATA ? "Programs" : "", "Git", "bin", "git.exe"));
  }
  return [...new Set(candidates)];
}

/** shellを介さずcommitを取得する。どの候補も使えない場合だけunknownを返す。 */
export function getGitRevision({
  cwd = process.cwd(),
  candidates = gitExecutableCandidates(),
  run = execFileSync,
  exists = existsSync,
} = {}) {
  for (const executable of candidates) {
    if (executable !== "git" && !exists(executable)) continue;
    try {
      return run(executable, ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim();
    } catch {
      // PATH候補が無い、またはリポジトリ外なら次候補へ
    }
  }
  return "unknown";
}
