import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface WorkingTreeDiff {
  text: string;
  changedFiles: string[];
}

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

function runGit(git: string, args: string[], cwd: string, expectedStatuses: number[] = [0]): string {
  const result = spawnSync(git, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error) {
    const detail = result.error.message.includes("ENOBUFS")
      ? `Git出力が${MAX_GIT_OUTPUT_BYTES / 1024 / 1024} MiB上限を超えました。対象を分けて git diff -- <path> を実行してください。`
      : `Gitの起動に失敗しました: ${result.error.message}`;
    throw new Error(detail);
  }
  if (result.status === null || !expectedStatuses.includes(result.status)) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(detail || `Gitがexit ${result.status ?? "unknown"}で失敗しました: git ${args.join(" ")}`);
  }
  return result.stdout;
}

function readNulList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/** stage済み・未stage・未追跡を含むworking treeの実diffを収集する。 */
export function collectWorkingTreeDiff(
  cwd = process.cwd(),
  git = resolveGitExecutable(),
  maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
): WorkingTreeDiff {
  try {
    const inside = runGit(git, ["rev-parse", "--is-inside-work-tree"], cwd).trim();
    if (inside !== "true") throw new Error("not a work tree");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Git repositoryではありません。対象repositoryへcdして再実行してください。 (${detail})`);
  }

  const hasHead =
    spawnSync(git, ["rev-parse", "--verify", "HEAD"], {
      cwd,
      stdio: "ignore",
      windowsHide: true,
    }).status === 0;

  const trackedDiffs: string[] = [];
  const trackedNames = new Set<string>();
  if (hasHead) {
    trackedDiffs.push(runGit(git, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"], cwd));
    for (const name of readNulList(runGit(git, ["diff", "--name-only", "-z", "HEAD", "--"], cwd))) {
      trackedNames.add(name);
    }
  } else {
    trackedDiffs.push(
      runGit(git, ["diff", "--no-ext-diff", "--binary", "--cached", "--"], cwd),
      runGit(git, ["diff", "--no-ext-diff", "--binary", "--"], cwd),
    );
    for (const args of [
      ["diff", "--name-only", "-z", "--cached", "--"],
      ["diff", "--name-only", "-z", "--"],
    ]) {
      for (const name of readNulList(runGit(git, args, cwd))) trackedNames.add(name);
    }
  }

  const untracked = readNulList(runGit(git, ["ls-files", "--others", "--exclude-standard", "-z"], cwd));
  const sections: string[] = [];
  let outputBytes = 0;
  const appendSection = (section: string): void => {
    if (!section.trim()) return;
    outputBytes += Buffer.byteLength(section, "utf8");
    if (outputBytes > maxOutputBytes) {
      throw new Error(
        `Git差分の合計が${Math.round(maxOutputBytes / 1024 / 1024)} MiB上限を超えました。対象を分けて git diff -- <path> を実行してください。`,
      );
    }
    sections.push(section);
  };
  for (const section of trackedDiffs) appendSection(section);
  for (const file of untracked) {
    const diff = runGit(git, ["diff", "--no-index", "--no-ext-diff", "--binary", "--", "/dev/null", file], cwd, [0, 1]);
    appendSection(diff);
  }

  return {
    text: sections.join("\n").trimEnd(),
    changedFiles: [...trackedNames, ...untracked].sort((a, b) => a.localeCompare(b)),
  };
}
