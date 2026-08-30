import { spawnSync } from "node:child_process";
import { MAX_GIT_OUTPUT_BYTES, resolveGitExecutable, runGitSync } from "../git/git-command.js";

export { resolveGitExecutable } from "../git/git-command.js";

export interface WorkingTreeDiff {
  text: string;
  changedFiles: string[];
}

function runGit(git: string, args: string[], cwd: string, expectedStatuses: number[] = [0]): string {
  try {
    return runGitSync(git, args, cwd, { expectedStatuses: expectedStatuses, maxBuffer: MAX_GIT_OUTPUT_BYTES });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/出力.*上限/.test(message)) {
      throw new Error(
        `Git差分の合計が${MAX_GIT_OUTPUT_BYTES / 1024 / 1024} MiB上限を超えました。対象を分けて git diff -- <path> を実行してください。`,
      );
    }
    throw error;
  }
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
