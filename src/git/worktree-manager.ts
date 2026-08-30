import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceContext } from "../agent/workspace-context.js";
import { pathStartsWith, safeResolvePath } from "../utils/platform.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import type { WorkingTreeDiff } from "../cli/worktree-diff.js";
import { MAX_GIT_OUTPUT_BYTES, resolveGitExecutable, runGitSync } from "./git-command.js";

export type WorkspaceState = "active" | "cleaned" | "changed" | "applied" | "discarded" | "error";

export interface ManagedWorktreeRecord {
  agentId: string;
  workspaceId: string;
  worktreePath: string;
  mainCheckoutRoot: string;
  repositoryCommonDir: string;
  baseCommit: string;
  workspaceState: WorkspaceState;
  changedFiles: string[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface WorktreeOperationResult {
  record: ManagedWorktreeRecord;
  message: string;
}

const META_VERSION = 1;
const TERMINAL_METADATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface PersistedRecord extends ManagedWorktreeRecord {
  version: number;
}

function readNulList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function samePath(a: string, b: string): boolean {
  return safeResolvePath(a) === safeResolvePath(b);
}

function resolveRepositoryPath(git: string, cwd: string, selector: "--show-toplevel" | "--git-common-dir"): string {
  return safeResolvePath(runGitSync(git, ["rev-parse", "--path-format=absolute", selector], cwd).trim());
}

/** agent単位のdetached worktreeを作成・保持・回収するmain-orchestrator専用manager。 */
export class WorktreeManager {
  private readonly git: string;
  private readonly mainRoot: string;
  private readonly repoRoot: string;
  private readonly commonDir: string;
  private readonly managedRoot: string;
  private readonly emptyHooksDir: string;
  private readonly records = new Map<string, ManagedWorktreeRecord>();

  constructor(options: { mainRoot?: string; managedRoot?: string; git?: string } = {}) {
    this.git = options.git ?? resolveGitExecutable();
    this.mainRoot = safeResolvePath(options.mainRoot ?? process.cwd());
    this.repoRoot = resolveRepositoryPath(this.git, this.mainRoot, "--show-toplevel");
    this.commonDir = resolveRepositoryPath(this.git, this.repoRoot, "--git-common-dir");
    const repoHash = createHash("sha256").update(this.commonDir).digest("hex").slice(0, 16);
    this.managedRoot = safeResolvePath(
      options.managedRoot ?? path.join(os.homedir(), ".localllm", "worktrees", repoHash),
    );
    this.emptyHooksDir = path.join(this.managedRoot, ".empty-hooks");
    fs.mkdirSync(this.emptyHooksDir, { recursive: true });
    this.loadRecords();
  }

  create(agentId: string): WorkspaceContext {
    const filterArgs = this.safeCheckoutConfig();
    this.requireCleanMain("worktree作成", false, filterArgs);
    const baseCommit = runGitSync(this.git, ["rev-parse", "--verify", "HEAD"], this.repoRoot).trim();
    if (!baseCommit) throw new Error("HEAD commitが無いためworktreeを作成できません。最初のcommitを作成してください。");

    const workspaceId = randomBytes(6).toString("hex");
    const worktreePath = path.join(this.managedRoot, workspaceId);
    this.assertManagedPath(worktreePath);
    if (fs.existsSync(worktreePath)) throw new Error(`Managed worktree path already exists: ${worktreePath}`);

    try {
      runGitSync(
        this.git,
        [...filterArgs, "worktree", "add", "--detach", "--no-checkout", worktreePath, baseCommit],
        this.repoRoot,
      );
      runGitSync(this.git, [...filterArgs, "reset", "--hard", baseCommit], worktreePath);
      this.verifyIdentity(worktreePath, baseCommit);
      runGitSync(
        this.git,
        ["worktree", "lock", "--reason", `localllm:${process.pid}:${workspaceId}`, worktreePath],
        this.repoRoot,
      );
    } catch (error) {
      try {
        runGitSync(this.git, ["worktree", "remove", "--force", worktreePath], this.repoRoot);
      } catch {
        // 作成途中で登録されていなければ削除対象が無い。元の原因を優先する。
      }
      throw error;
    }

    const now = new Date().toISOString();
    const record: ManagedWorktreeRecord = {
      agentId,
      workspaceId,
      worktreePath: safeResolvePath(worktreePath),
      mainCheckoutRoot: this.repoRoot,
      repositoryCommonDir: this.commonDir,
      baseCommit,
      workspaceState: "active",
      changedFiles: [],
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(agentId, record);
    this.persist(record);
    return this.toContext(record);
  }

  finalize(agentId: string): ManagedWorktreeRecord | undefined {
    const record = this.records.get(agentId);
    if (record?.workspaceState !== "active") return record;
    try {
      this.verifyIdentity(record.worktreePath);
      const diff = this.collectDiff(record);
      const head = runGitSync(this.git, ["rev-parse", "HEAD"], record.worktreePath).trim();
      try {
        runGitSync(this.git, ["worktree", "unlock", record.worktreePath], this.repoRoot);
      } catch {
        // 既にunlockされていても状態集計は継続する。
      }
      if (diff.changedFiles.length === 0 && head === record.baseCommit) {
        runGitSync(this.git, ["worktree", "remove", record.worktreePath], this.repoRoot);
        record.workspaceState = "cleaned";
      } else {
        record.workspaceState = "changed";
        record.changedFiles = diff.changedFiles;
      }
      record.updatedAt = new Date().toISOString();
      this.persist(record);
    } catch (error) {
      record.workspaceState = "error";
      record.error = error instanceof Error ? error.message : String(error);
      record.updatedAt = new Date().toISOString();
      this.persist(record);
    }
    return { ...record, changedFiles: [...record.changedFiles] };
  }

  get(agentId: string): ManagedWorktreeRecord | undefined {
    const record = this.records.get(agentId);
    return record ? { ...record, changedFiles: [...record.changedFiles] } : undefined;
  }

  listRecoverable(): ManagedWorktreeRecord[] {
    return [...this.records.values()]
      .filter((record) => !["cleaned", "applied", "discarded"].includes(record.workspaceState))
      .map((record) => ({ ...record, changedFiles: [...record.changedFiles] }));
  }

  diff(agentId: string): WorkingTreeDiff {
    const record = this.requireRecoverable(agentId);
    this.verifyIdentity(record.worktreePath);
    return this.collectDiff(record);
  }

  apply(agentId: string): WorktreeOperationResult {
    const record = this.requireRecoverable(agentId);
    if (record.workspaceState === "active")
      throw new Error(`Agent ${agentId} is still running. 完了後に再実行してください。`);
    this.verifyIdentity(record.worktreePath);
    const safeArgs = this.safeCheckoutConfig();
    this.requireCleanMain("task_apply", false, safeArgs);
    const mainHead = runGitSync(this.git, ["rev-parse", "HEAD"], this.repoRoot).trim();
    if (mainHead !== record.baseCommit) {
      throw new Error(
        `main HEADがbase commitから進んでいます (${mainHead.slice(0, 8)} != ${record.baseCommit.slice(0, 8)})。` +
          "変更を手動でrebase/移植してから再実行してください。自動3-way mergeは行いません。",
      );
    }
    const rawModes = runGitSync(
      this.git,
      [...safeArgs, "diff", "--raw", "--no-ext-diff", "--no-textconv", record.baseCommit, "--"],
      record.worktreePath,
    );
    if (/\b(?:120000|160000)\b/.test(rawModes)) {
      throw new Error(
        "task_applyはtracked symlink/submodule (mode 120000/160000)に未対応です。" +
          "通常fileへ変更するか、隔離worktreeから手動で移植してください。worktreeは保持します。",
      );
    }
    const diff = this.collectDiff(record);
    if (!diff.text.trim()) throw new Error(`Agent ${agentId} の回収可能な差分がありません。`);
    const trackedPatch = runGitSync(
      this.git,
      [...safeArgs, "diff", "--no-ext-diff", "--no-textconv", "--binary", record.baseCommit, "--"],
      record.worktreePath,
    );
    const patchInput = trackedPatch.trim() ? `${trackedPatch.trimEnd()}\n` : "";
    const untracked = readNulList(
      runGitSync(this.git, [...safeArgs, "ls-files", "--others", "--exclude-standard", "-z"], record.worktreePath),
    );
    for (const relativePath of untracked) {
      const source = safeResolvePath(path.join(record.worktreePath, relativePath));
      const destination = safeResolvePath(path.join(this.repoRoot, relativePath));
      if (
        !pathStartsWith(source, safeResolvePath(record.worktreePath)) ||
        !pathStartsWith(destination, this.repoRoot)
      ) {
        throw new Error(`untracked pathがworkspace外へ解決されました: ${relativePath}`);
      }
      if (!fs.lstatSync(source).isFile())
        throw new Error(`untracked symlink/directoryはtask_apply未対応です: ${relativePath}`);
      if (fs.existsSync(destination)) throw new Error(`mainに同名pathが既に存在します: ${relativePath}`);
    }
    if (patchInput) {
      runGitSync(this.git, [...safeArgs, "apply", "--check", "--binary", "-"], this.repoRoot, { input: patchInput });
    }
    this.requireCleanMain("task_apply直前", true, safeArgs);
    const createdUntracked: string[] = [];
    try {
      if (patchInput) {
        runGitSync(this.git, [...safeArgs, "apply", "--binary", "-"], this.repoRoot, { input: patchInput });
      }
      for (const relativePath of untracked) {
        const source = path.join(record.worktreePath, relativePath);
        const destination = path.join(this.repoRoot, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, fs.statSync(source).mode);
        createdUntracked.push(destination);
      }
    } catch (error) {
      for (const created of createdUntracked.reverse()) {
        try {
          fs.rmSync(created, { force: true });
        } catch {
          // best effort rollback; mainのdirty stateは次のエラーで可視化される。
        }
      }
      if (patchInput) {
        try {
          runGitSync(this.git, [...safeArgs, "apply", "--reverse", "--binary", "-"], this.repoRoot, {
            input: patchInput,
          });
        } catch {
          // best effort rollback
        }
      }
      throw error;
    }
    const applied = this.collectDiffFromBase(this.repoRoot, record.baseCommit);
    const sourceSignature = this.filesystemSignature(record.worktreePath, diff.changedFiles);
    const appliedSignature = this.filesystemSignature(this.repoRoot, applied.changedFiles);
    if (sourceSignature !== appliedSignature) {
      try {
        for (const created of createdUntracked.reverse()) fs.rmSync(created, { force: true });
        if (patchInput) {
          runGitSync(this.git, [...safeArgs, "apply", "--reverse", "--binary", "-"], this.repoRoot, {
            input: patchInput,
          });
        }
      } catch {
        // rollback不能ならmainのdirty stateを隠さず元エラーへ明記する。
      }
      throw new Error(
        "task_apply後のfilesystem検証が一致しません。mainの状態を確認してください。worktreeは保持しました。" +
          ` source=${sourceSignature} applied=${appliedSignature}`,
      );
    }
    try {
      runGitSync(this.git, ["worktree", "unlock", record.worktreePath], this.repoRoot);
    } catch {
      // already unlocked
    }
    runGitSync(this.git, ["worktree", "remove", "--force", record.worktreePath], this.repoRoot);
    record.workspaceState = "applied";
    record.changedFiles = diff.changedFiles;
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    return { record: { ...record }, message: `${diff.changedFiles.length} file(s)をmain checkoutへ適用しました。` };
  }

  discard(agentId: string): WorktreeOperationResult {
    const record = this.requireRecoverable(agentId);
    if (record.workspaceState === "active")
      throw new Error(`Agent ${agentId} is still running. cancelまたは完了後に再実行してください。`);
    this.verifyIdentity(record.worktreePath);
    const diff = this.collectDiff(record);
    try {
      runGitSync(this.git, ["worktree", "unlock", record.worktreePath], this.repoRoot);
    } catch {
      // already unlocked
    }
    runGitSync(this.git, ["worktree", "remove", "--force", record.worktreePath], this.repoRoot);
    record.workspaceState = "discarded";
    record.changedFiles = diff.changedFiles;
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    return { record: { ...record }, message: `${diff.changedFiles.length} file(s)の隔離変更を破棄しました。` };
  }

  private collectDiff(record: ManagedWorktreeRecord): WorkingTreeDiff {
    return this.collectDiffFromBase(record.worktreePath, record.baseCommit);
  }

  private collectDiffFromBase(cwd: string, baseCommit: string): WorkingTreeDiff {
    const safeArgs = this.safeCheckoutConfig();
    const tracked = runGitSync(
      this.git,
      [...safeArgs, "diff", "--no-ext-diff", "--no-textconv", "--binary", baseCommit, "--"],
      cwd,
    );
    const trackedNames = readNulList(
      runGitSync(this.git, [...safeArgs, "diff", "--name-only", "-z", baseCommit, "--"], cwd),
    );
    const untracked = readNulList(
      runGitSync(this.git, [...safeArgs, "ls-files", "--others", "--exclude-standard", "-z"], cwd),
    );
    const sections = [tracked];
    let bytes = Buffer.byteLength(tracked, "utf8");
    for (const file of untracked) {
      const section = runGitSync(
        this.git,
        [...safeArgs, "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--binary", "--", "/dev/null", file],
        cwd,
        { expectedStatuses: [0, 1] },
      );
      bytes += Buffer.byteLength(section, "utf8");
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        throw new Error("Git差分の合計が8 MiB上限を超えました。変更を分割してから再実行してください。");
      }
      sections.push(section);
    }
    return {
      text: sections
        .filter((section) => section.trim())
        .join("\n")
        .trimEnd(),
      changedFiles: [...new Set([...trackedNames, ...untracked])].sort((a, b) => a.localeCompare(b)),
    };
  }

  private filesystemSignature(root: string, changedFiles: string[]): string {
    const entries = changedFiles.map((relativePath) => {
      const absolutePath = safeResolvePath(path.join(root, relativePath));
      if (!pathStartsWith(absolutePath, safeResolvePath(root))) {
        throw new Error(`差分pathがworkspace外へ解決されました: ${relativePath}`);
      }
      if (!fs.existsSync(absolutePath)) return { path: relativePath, type: "deleted" };
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        return { path: relativePath, type: "symlink", target: fs.readlinkSync(absolutePath) };
      }
      if (!stat.isFile()) throw new Error(`未対応の差分種別です: ${relativePath}`);
      return {
        path: relativePath,
        type: "file",
        executable: (stat.mode & 0o111) !== 0,
        sha256: createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
      };
    });
    return JSON.stringify(entries);
  }

  private requireRecoverable(agentId: string): ManagedWorktreeRecord {
    const record = this.records.get(agentId);
    if (!record)
      throw new Error(`Agent ${agentId} のmanaged worktreeが見つかりません。task_listでIDを確認してください。`);
    if (["cleaned", "applied", "discarded"].includes(record.workspaceState)) {
      throw new Error(`Agent ${agentId} のworktreeは既に ${record.workspaceState} です。`);
    }
    return record;
  }

  private requireCleanMain(operation: string, allowNoChangesOnly = false, safeArgs = this.safeCheckoutConfig()): void {
    const status = runGitSync(
      this.git,
      [...safeArgs, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      this.repoRoot,
    );
    if (status) {
      const detail = allowNoChangesOnly
        ? "別processによる変更を検出しました"
        : "staged/unstaged/untracked変更があります";
      throw new Error(
        `${operation}を開始できません: main checkoutに${detail}。` +
          "変更をcommitまたは明示的に退避してcleanにしてください。stashやshared実行へ自動代替しません。",
      );
    }
  }

  private verifyIdentity(worktreePath: string, expectedHead?: string): void {
    this.assertManagedPath(worktreePath);
    if (!fs.existsSync(worktreePath)) throw new Error(`Managed worktreeが見つかりません: ${worktreePath}`);
    const top = resolveRepositoryPath(this.git, worktreePath, "--show-toplevel");
    const common = resolveRepositoryPath(this.git, worktreePath, "--git-common-dir");
    if (!samePath(top, worktreePath) || !samePath(common, this.commonDir)) {
      throw new Error(
        "Managed worktreeのGit identityが作成時と一致しません。操作を停止しました。" +
          ` top=${top} expectedTop=${safeResolvePath(worktreePath)}` +
          ` common=${common} expectedCommon=${this.commonDir}`,
      );
    }
    if (expectedHead) {
      const head = runGitSync(this.git, ["rev-parse", "HEAD"], worktreePath).trim();
      if (head !== expectedHead) throw new Error("Managed worktreeのHEADが作成直後にbase commitと一致しません。");
    }
  }

  private assertManagedPath(target: string): void {
    const root = safeResolvePath(this.managedRoot);
    const resolved = safeResolvePath(target);
    if (!pathStartsWith(resolved, root) || samePath(resolved, root)) {
      throw new Error(`Managed root外のworktree pathを拒否しました: ${target}`);
    }
  }

  private safeCheckoutConfig(): string[] {
    const localIncludes = runGitSync(
      this.git,
      ["config", "--local", "--name-only", "--get-regexp", "^include(If\\..*)?\\.path$"],
      this.repoRoot,
      { expectedStatuses: [0, 1] },
    ).trim();
    if (localIncludes) {
      throw new Error(
        "repository-local include/includeIfがあるためcheckout時のGit設定を安全に確定できません。" +
          "local includeを除去してからworktreeを再実行してください。",
      );
    }
    const output = runGitSync(
      this.git,
      ["config", "--name-only", "--null", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"],
      this.repoRoot,
      { expectedStatuses: [0, 1] },
    );
    const configuredEntries = output.split("\0").filter(Boolean);
    const tracked = runGitSync(this.git, ["ls-files", "-z"], this.repoRoot);
    const attributes = tracked
      ? runGitSync(this.git, ["check-attr", "-z", "--stdin", "filter"], this.repoRoot, { input: tracked })
      : "";
    const attributeParts = attributes.split("\0").filter(Boolean);
    const activeFilters = new Set<string>();
    for (let i = 0; i + 2 < attributeParts.length; i += 3) {
      const value = attributeParts[i + 2];
      if (value && !["unspecified", "unset", "set"].includes(value)) activeFilters.add(value);
    }
    const activeEntries = configuredEntries.filter((entry) => {
      const match = entry.match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/);
      return match ? activeFilters.has(match[1]) : true;
    });
    if (activeEntries.length > 0) {
      throw new Error(
        `checkout対象に有効なGit filter (${activeEntries.join(", ")}) はstatus/checkout時にexternal processを起動し得るため` +
          "worktree作成を拒否しました。filter属性/実行設定を除去するか、明示的にshared taskを選択してください。",
      );
    }
    const args = ["-c", `core.hooksPath=${this.emptyHooksDir}`, "-c", "core.fsmonitor=false"];
    return args;
  }

  private toContext(record: ManagedWorktreeRecord): WorkspaceContext {
    return {
      mode: "worktree",
      root: record.worktreePath,
      mainCheckoutRoot: record.mainCheckoutRoot,
      repositoryCommonDir: record.repositoryCommonDir,
      workspaceId: record.workspaceId,
      baseCommit: record.baseCommit,
    };
  }

  private metadataPath(agentId: string): string {
    return path.join(this.managedRoot, `.record-${agentId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  private persist(record: ManagedWorktreeRecord): void {
    fs.mkdirSync(this.managedRoot, { recursive: true });
    writeFileAtomic(
      this.metadataPath(record.agentId),
      `${JSON.stringify({ version: META_VERSION, ...record }, null, 2)}\n`,
    );
  }

  private loadRecords(): void {
    if (!fs.existsSync(this.managedRoot)) return;
    for (const name of fs.readdirSync(this.managedRoot)) {
      if (!name.startsWith(".record-") || !name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.managedRoot, name), "utf8")) as PersistedRecord;
        if (parsed.version !== META_VERSION || !samePath(parsed.mainCheckoutRoot, this.repoRoot)) continue;
        if (
          ["cleaned", "applied", "discarded"].includes(parsed.workspaceState) &&
          Date.now() - Date.parse(parsed.updatedAt) > TERMINAL_METADATA_RETENTION_MS
        ) {
          fs.rmSync(path.join(this.managedRoot, name), { force: true });
          continue;
        }
        const recoveredActive = parsed.workspaceState === "active";
        if (recoveredActive) {
          parsed.workspaceState = "error";
          parsed.error =
            "Previous process ended while the worktree was active. Inspect diff, then apply or discard explicitly.";
          parsed.updatedAt = new Date().toISOString();
        }
        this.records.set(parsed.agentId, parsed);
        if (recoveredActive) this.persist(parsed);
      } catch {
        // 壊れた/他repositoryのmetadataを信頼しない。
      }
    }
  }
}
