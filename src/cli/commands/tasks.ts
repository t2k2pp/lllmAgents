import chalk from "chalk";
import { getSubAgentManager } from "../../tools/definitions/task.js";
import { confirm } from "../prompt-gate.js";
import type { ReplCommandDef } from "./types.js";

function requireManager() {
  const manager = getSubAgentManager();
  if (!manager) throw new Error("SubAgentManager is not initialized.");
  return manager;
}

export const tasksCommand: ReplCommandDef = {
  name: "/tasks",
  summary: "background taskとmanaged worktreeの一覧・diff・apply・discard",
  completions: [
    { command: "/tasks", description: "task/worktree一覧を表示" },
    { command: "/tasks diff", description: "隔離差分を表示", needsArg: true },
    { command: "/tasks apply", description: "隔離差分をmainへ適用", needsArg: true },
    { command: "/tasks discard", description: "隔離変更を明示破棄", needsArg: true },
  ],
  async handler(_ctx, args) {
    try {
      const manager = requireManager();
      const operation = args[0]?.toLowerCase() ?? "list";
      const agentId = args[1];
      if (operation === "list") {
        const tasks = manager.listBackgroundTasks();
        const recoverable = manager.listRecoverableWorktrees();
        const capabilityError = manager.getWorktreeCapabilityError();
        if (tasks.length === 0 && recoverable.length === 0 && !capabilityError) {
          console.log(chalk.dim("  task/worktreeなし"));
          return;
        }
        for (const task of tasks) {
          const workspace = task.workspaceState ? ` workspace=${task.workspaceState}` : "";
          console.log(`  ${task.agentId}  ${task.status}${workspace}  ${task.description}`);
        }
        const activeIds = new Set(tasks.map((task) => task.agentId));
        for (const record of recoverable) {
          if (activeIds.has(record.agentId)) continue;
          console.log(
            `  ${record.agentId}  recovered workspace=${record.workspaceState}  ${record.changedFiles.length} file(s)  ${record.worktreePath}`,
          );
        }
        if (capabilityError) console.log(chalk.yellow(`  worktree unavailable: ${capabilityError}`));
        return;
      }
      if (!agentId) {
        console.log(chalk.yellow(`  使い方: /tasks ${operation} <agent-id>`));
        return;
      }
      if (operation === "diff") {
        const diff = manager.diffWorktree(agentId);
        console.log(chalk.dim(`  ${diff.changedFiles.length} file(s): ${diff.changedFiles.join(", ")}\n`));
        console.log(diff.text || chalk.dim("  差分なし"));
        return;
      }
      if (operation !== "apply" && operation !== "discard") {
        console.log(chalk.yellow("  使い方: /tasks [list|diff|apply|discard] <agent-id>"));
        return;
      }
      const record = manager.listRecoverableWorktrees().find((candidate) => candidate.agentId === agentId);
      if (!record) throw new Error(`Agent ${agentId} の回収可能なmanaged worktreeが見つかりません。`);
      console.log(
        chalk.yellow(`  ${record.changedFiles.length} file(s): ${record.changedFiles.join(", ") || "(未集計)"}`),
      );
      const approved = await confirm({
        message:
          operation === "apply"
            ? `この隔離差分をcleanなmain checkoutへ適用しますか? (${agentId})`
            : `このmanaged worktreeと未回収変更を破棄しますか? (${agentId})`,
        default: false,
      });
      if (!approved) {
        console.log(chalk.dim("  取り消しました。worktreeは保持されています。"));
        return;
      }
      const result = operation === "apply" ? manager.applyWorktree(agentId) : manager.discardWorktree(agentId);
      console.log(chalk.green(`  ${result.message}`));
    } catch (error) {
      console.log(chalk.red(`  /tasks失敗: ${error instanceof Error ? error.message : String(error)}`));
    }
  },
};
