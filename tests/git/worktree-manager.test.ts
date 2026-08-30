import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitExecutable } from "../../src/git/git-command.js";
import { WorktreeManager } from "../../src/git/worktree-manager.js";

const roots: string[] = [];

function initRepo(): { repo: string; managed: string; git: string } {
  const git = resolveGitExecutable();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lllm-worktree-"));
  roots.push(root);
  const repo = path.join(root, "main");
  const managed = path.join(root, "managed");
  fs.mkdirSync(repo);
  execFileSync(git, ["init", "--quiet"], { cwd: repo });
  execFileSync(git, ["config", "user.name", "Worktree Test"], { cwd: repo });
  execFileSync(git, ["config", "user.email", "worktree@example.invalid"], { cwd: repo });
  execFileSync(git, ["config", "core.autocrlf", "false"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n", "utf8");
  execFileSync(git, ["add", "tracked.txt"], { cwd: repo });
  execFileSync(git, ["commit", "--quiet", "-m", "initial"], { cwd: repo });
  return { repo, managed, git };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("WorktreeManager", () => {
  it("mainを不変に保って変更を保持し、明示applyで完全なfilesystem stateを回収する", () => {
    const { repo, managed, git } = initRepo();
    const manager = new WorktreeManager({ mainRoot: repo, managedRoot: managed, git });
    const workspace = manager.create("sub-apply");

    fs.writeFileSync(path.join(workspace.root, "tracked.txt"), "after\n", "utf8");
    fs.writeFileSync(path.join(workspace.root, "new.bin"), Buffer.from([0, 1, 2, 255]));
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("before\n");

    const finalized = manager.finalize("sub-apply");
    expect(finalized).toEqual(
      expect.objectContaining({ workspaceState: "changed", changedFiles: ["new.bin", "tracked.txt"] }),
    );
    expect(manager.diff("sub-apply").text).toContain("tracked.txt");

    const applied = manager.apply("sub-apply");
    expect(applied.record.workspaceState).toBe("applied");
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("after\n");
    expect(fs.readFileSync(path.join(repo, "new.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(fs.existsSync(workspace.root)).toBe(false);
  }, 30_000);

  it("dirty mainでは作成せず、shared executionへfallbackしない", () => {
    const { repo, managed, git } = initRepo();
    fs.writeFileSync(path.join(repo, "untracked.txt"), "user work\n", "utf8");
    const manager = new WorktreeManager({ mainRoot: repo, managedRoot: managed, git });
    expect(() => manager.create("sub-dirty")).toThrow(/main checkout.*untracked.*自動代替/i);
    expect(fs.existsSync(path.join(managed, "sub-dirty"))).toBe(false);
  });

  it("repository-local post-checkout hookを実行せずworktreeを作る", () => {
    const { repo, managed, git } = initRepo();
    const hooks = path.join(repo, "hooks");
    const sentinel = path.join(repo, "hook-ran.txt");
    fs.mkdirSync(hooks);
    const hook = path.join(hooks, "post-checkout");
    fs.writeFileSync(hook, `#!/bin/sh\nprintf unsafe > "${sentinel.replace(/\\/g, "/")}"\n`, "utf8");
    fs.chmodSync(hook, 0o755);
    execFileSync(git, ["add", "hooks/post-checkout"], { cwd: repo });
    execFileSync(git, ["commit", "--quiet", "-m", "add repository hook"], { cwd: repo });
    execFileSync(git, ["config", "core.hooksPath", hooks], { cwd: repo });

    const manager = new WorktreeManager({ mainRoot: repo, managedRoot: managed, git });
    const workspace = manager.create("sub-hook");
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(manager.finalize("sub-hook")?.workspaceState).toBe("cleaned");
    expect(fs.existsSync(workspace.root)).toBe(false);
  });

  it("repository-local filterがあればstatus前にfail-fastしexternal processを起動しない", () => {
    const { repo, managed, git } = initRepo();
    const sentinel = path.join(path.dirname(repo), "filter-ran.txt");
    fs.writeFileSync(path.join(repo, ".gitattributes"), "filtered.txt filter=evil\n", "utf8");
    fs.writeFileSync(path.join(repo, "filtered.txt"), "stored\n", "utf8");
    execFileSync(git, ["add", ".gitattributes", "filtered.txt"], { cwd: repo });
    execFileSync(git, ["commit", "--quiet", "-m", "add filtered file"], { cwd: repo });
    const script = `node -e "require('fs').writeFileSync('${sentinel.replace(/\\/g, "/")}','unsafe')"`;
    execFileSync(git, ["config", "filter.evil.smudge", script], { cwd: repo });
    execFileSync(git, ["config", "filter.evil.required", "true"], { cwd: repo });

    const manager = new WorktreeManager({ mainRoot: repo, managedRoot: managed, git });
    expect(() => manager.create("sub-filter")).toThrow(/有効なGit filter.*external process.*shared task/i);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(manager.get("sub-filter")).toBeUndefined();
  });

  it("base commitが進んだmainへのapplyを拒否し、worktreeを保持する", () => {
    const { repo, managed, git } = initRepo();
    const manager = new WorktreeManager({ mainRoot: repo, managedRoot: managed, git });
    const workspace = manager.create("sub-drift");
    fs.writeFileSync(path.join(workspace.root, "tracked.txt"), "isolated\n", "utf8");
    manager.finalize("sub-drift");

    fs.writeFileSync(path.join(repo, "main-only.txt"), "advance\n", "utf8");
    execFileSync(git, ["add", "main-only.txt"], { cwd: repo });
    execFileSync(git, ["commit", "--quiet", "-m", "advance"], { cwd: repo });

    expect(() => manager.apply("sub-drift")).toThrow(/base commit.*自動3-way/i);
    expect(fs.existsSync(workspace.root)).toBe(true);
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("before\n");
  });

  it("tracked symlink/submodule modeをmainへ適用せずworktreeを保持する", () => {
    const { repo, managed, git } = initRepo();
    const manager = new WorktreeManager({ mainRoot: repo, managedRoot: managed, git });
    const workspace = manager.create("sub-gitlink");
    execFileSync(git, ["clone", "--quiet", "--no-checkout", repo, path.join(workspace.root, "module")]);
    execFileSync(git, ["checkout", "--quiet", workspace.baseCommit ?? ""], {
      cwd: path.join(workspace.root, "module"),
    });
    execFileSync(git, ["update-index", "--add", "--cacheinfo", "160000", workspace.baseCommit ?? "", "module"], {
      cwd: workspace.root,
    });
    manager.finalize("sub-gitlink");

    expect(() => manager.apply("sub-gitlink")).toThrow(/symlink\/submodule.*未対応/i);
    expect(fs.existsSync(workspace.root)).toBe(true);
    expect(fs.existsSync(path.join(repo, "module"))).toBe(false);
    manager.discard("sub-gitlink");
  });

  it("明示discardだけが変更ありmanaged worktreeをforce removeする", () => {
    const { repo, managed, git } = initRepo();
    const manager = new WorktreeManager({ mainRoot: repo, managedRoot: managed, git });
    const workspace = manager.create("sub-discard");
    fs.writeFileSync(path.join(workspace.root, "tracked.txt"), "discard me\n", "utf8");
    manager.finalize("sub-discard");

    const result = manager.discard("sub-discard");
    expect(result.record.workspaceState).toBe("discarded");
    expect(fs.existsSync(workspace.root)).toBe(false);
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("before\n");
  });

  it("process再起動相当でもactive worktreeを誤削除せずdiff/discardへ回収する", () => {
    const { repo, managed, git } = initRepo();
    const first = new WorktreeManager({ mainRoot: repo, managedRoot: managed, git });
    const workspace = first.create("sub-crash");
    fs.writeFileSync(path.join(workspace.root, "tracked.txt"), "survive crash\n", "utf8");

    const recovered = new WorktreeManager({ mainRoot: repo, managedRoot: managed, git });
    expect(recovered.listRecoverable()).toEqual([
      expect.objectContaining({ agentId: "sub-crash", workspaceState: "error", worktreePath: workspace.root }),
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(managed, ".record-sub-crash.json"), "utf8")).workspaceState).toBe(
      "error",
    );
    expect(recovered.diff("sub-crash").text).toContain("survive crash");
    recovered.discard("sub-crash");
    expect(fs.existsSync(workspace.root)).toBe(false);
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("before\n");
  });
});
