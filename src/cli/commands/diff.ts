import chalk from "chalk";
import { collectWorkingTreeDiff } from "../worktree-diff.js";
import type { ReplCommandDef } from "./types.js";

export const diffCommand: ReplCommandDef = {
  name: "/diff",
  summary: "stage済み・未stage・未追跡を含むGit差分を表示",
  completions: [{ command: "/diff", description: "working treeの実Git差分を表示" }],
  handler() {
    console.log(chalk.dim("  working treeのGit差分を表示..."));
    try {
      const result = collectWorkingTreeDiff();
      if (result.changedFiles.length === 0) {
        console.log(chalk.dim("  変更なし"));
        return;
      }
      console.log(chalk.dim(`  ${result.changedFiles.length} file(s): ${result.changedFiles.join(", ")}\n`));
      console.log(result.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`  /diff失敗: ${message}`));
    }
  },
};
