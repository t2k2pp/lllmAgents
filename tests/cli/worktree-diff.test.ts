import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectWorkingTreeDiff, resolveGitExecutable } from "../../src/cli/worktree-diff.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("collectWorkingTreeDiff", () => {
  it("stage/unstage済みの実差分と未追跡ファイル本文を一度に返す", () => {
    const git = resolveGitExecutable();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-diff-"));
    tempDirs.push(repo);
    execFileSync(git, ["init", "--quiet"], { cwd: repo });
    execFileSync(git, ["config", "user.name", "Diff Test"], { cwd: repo });
    execFileSync(git, ["config", "user.email", "diff@example.invalid"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n", "utf8");
    fs.writeFileSync(path.join(repo, "staged.txt"), "old staged\n", "utf8");
    execFileSync(git, ["add", "tracked.txt", "staged.txt"], { cwd: repo });
    execFileSync(git, ["commit", "--quiet", "-m", "initial"], { cwd: repo });

    fs.writeFileSync(path.join(repo, "tracked.txt"), "after\n", "utf8");
    fs.writeFileSync(path.join(repo, "staged.txt"), "new staged\n", "utf8");
    execFileSync(git, ["add", "staged.txt"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "untracked.txt"), "new file body\n", "utf8");

    const result = collectWorkingTreeDiff(repo, git);

    expect(result.changedFiles).toEqual(["staged.txt", "tracked.txt", "untracked.txt"]);
    expect(result.text).toContain("-before");
    expect(result.text).toContain("+after");
    expect(result.text).toContain("+new staged");
    expect(result.text).toContain("untracked.txt");
    expect(result.text).toContain("+new file body");
  });

  it("Git repositoryでなければ原因と復旧方法を示して失敗する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-diff-not-repo-"));
    tempDirs.push(dir);
    expect(() => collectWorkingTreeDiff(dir, resolveGitExecutable())).toThrow(/Git repository.*cd/i);
  });

  it("複数ファイルの合計出力が上限を超えたら、省略せず対象分割を求める", () => {
    const git = resolveGitExecutable();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-diff-limit-"));
    tempDirs.push(repo);
    execFileSync(git, ["init", "--quiet"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "one.txt"), "one body\n", "utf8");
    fs.writeFileSync(path.join(repo, "two.txt"), "two body\n", "utf8");

    expect(() => collectWorkingTreeDiff(repo, git, 32)).toThrow(/合計.*上限.*git diff -- <path>/);
  });
});
