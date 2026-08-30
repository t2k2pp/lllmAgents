import * as path from "node:path";
import * as fs from "node:fs";
import { pathStartsWith, safeResolvePath } from "../utils/platform.js";

export type WorkspaceMode = "shared" | "worktree";

export interface WorkspaceContext {
  mode: WorkspaceMode;
  root: string;
  mainCheckoutRoot: string;
  repositoryCommonDir?: string;
  workspaceId?: string;
  baseCommit?: string;
}

export function createSharedWorkspace(root = process.cwd()): WorkspaceContext {
  const resolved = safeResolvePath(root);
  return { mode: "shared", root: resolved, mainCheckoutRoot: resolved };
}

/** relative pathをagent固有rootで解決し、worktree外へのsymlink/junction到達を拒否する。 */
export function resolveWorkspacePath(workspace: WorkspaceContext, input: string): string {
  const candidate = path.isAbsolute(input) ? input : path.resolve(workspace.root, input);
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const resolved = suffix.reduce((current, segment) => path.join(current, segment), safeResolvePath(cursor));
  if (workspace.mode === "worktree" && !pathStartsWith(resolved, safeResolvePath(workspace.root))) {
    throw new Error(
      `Worktree isolation blocked path outside ${workspace.root}: ${input}. ` +
        "対象worktree内の相対パスへ変更してください。shared modeへは自動切替しません。",
    );
  }
  return resolved;
}

export function workspacePromptBlock(workspace: WorkspaceContext): string {
  if (workspace.mode !== "worktree") return "";
  return [
    "# Isolated workspace",
    `- Working directory: ${workspace.root}`,
    `- Workspace ID: ${workspace.workspaceId ?? "unknown"}`,
    `- Base commit: ${workspace.baseCommit ?? "unknown"}`,
    "All filesystem and shell work must stay inside this worktree. The main checkout is not an allowed target.",
  ].join("\n");
}

const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/][^\s'"`|;&<>(){}]+|(?<![\w.\-/])\/[\w.\-/]+)/g;

/** shell文字列から明白なworkspace脱出とGit redirectを拒否する。 */
export function assertWorkspaceCommand(workspace: WorkspaceContext, command: string): void {
  if (workspace.mode !== "worktree") return;
  if (/\bGIT_(?:DIR|WORK_TREE)\s*=|--git-dir(?:=|\s)|--work-tree(?:=|\s)|\bgit\s+-C(?:\s|$)/i.test(command)) {
    throw new Error(
      "Worktree isolation blocked Git directory redirection (git -C/--git-dir/--work-tree/GIT_DIR/GIT_WORK_TREE). " +
        "worktree cwd内で通常のgit commandを実行してください。",
    );
  }
  if (/(^|[\s'"=])\.\.[\\/]/.test(command)) {
    throw new Error("Worktree isolation blocked a parent-directory path. worktree内の相対パスへ書き換えてください。");
  }
  for (const candidate of command.match(ABSOLUTE_PATH) ?? []) {
    resolveWorkspacePath(workspace, candidate);
  }
}
