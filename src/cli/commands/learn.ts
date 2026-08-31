import chalk from "chalk";
import type { WorkflowLearnScope } from "../../workflow-learning/workflow-learner.js";
import type { ReplCommandDef, ReplCommandContext } from "./types.js";

function requireLearner(ctx: ReplCommandContext) {
  if (!ctx.workflowLearner) throw new Error("Workflow learning is not initialized in this session.");
  return ctx.workflowLearner;
}

function printStatus(ctx: ReplCommandContext): void {
  const status = requireLearner(ctx).status();
  if (!status.active) {
    console.log(
      chalk.dim(
        `  操作記録: inactive (利用可能: ${status.supportedScopes.length > 0 ? status.supportedScopes.join(", ") : "none"})`,
      ),
    );
    return;
  }
  console.log(
    chalk.dim(
      `  操作記録: ${status.name} / ${status.scope} / success=${status.successfulSteps} failure=${status.failedSteps}`,
    ),
  );
}

export const learnCommand: ReplCommandDef = {
  name: "/learn",
  summary: "browser/computerの成功操作を秘密値を除いた手動起動skillとして学習",
  completions: [
    { command: "/learn", description: "操作学習の状態を表示" },
    { command: "/learn status", description: "現在の操作記録状態を表示" },
    {
      command: "/learn start",
      description: "/learn start <name> <browser|computer|both> [説明]",
      needsArg: true,
    },
    { command: "/learn finish", description: "失敗のない操作記録をproject skillへ保存" },
    { command: "/learn cancel", description: "操作記録を保存せず破棄" },
  ],
  handler(ctx, args) {
    try {
      const learner = requireLearner(ctx);
      const subcommand = (args[0] ?? "status").toLowerCase();
      if (subcommand === "status") {
        printStatus(ctx);
        return;
      }
      if (subcommand === "start") {
        const name = args[1] ?? "";
        const scope = (args[2] ?? "") as WorkflowLearnScope;
        const description = args.slice(3).join(" ") || `${name} の記録済み操作workflow`;
        if (!name || !["browser", "computer", "both"].includes(scope)) {
          console.log(chalk.yellow("  使い方: /learn start <name> <browser|computer|both> [説明]"));
          return;
        }
        learner.start(name, description, scope);
        console.log(
          chalk.green(`  操作記録を開始しました: ${name} (${scope})。次のpromptから対象操作を順番に実演してください。`),
        );
        return;
      }
      if (subcommand === "finish") {
        if (!ctx.skillRegistry) throw new Error("SkillRegistry is not initialized in this session.");
        const result = learner.finish(ctx.skillRegistry);
        console.log(
          chalk.green(
            `  ${result.stepCount} stepを ${result.skill.trigger} として保存しました (${result.placeholderCount}値を秘匿)。`,
          ),
        );
        console.log(chalk.dim(`  ${result.filePath}`));
        return;
      }
      if (subcommand === "cancel") {
        learner.cancel();
        console.log(chalk.dim("  操作記録を破棄しました。skillは作成していません。"));
        return;
      }
      console.log(chalk.yellow("  使い方: /learn [status|start|finish|cancel]"));
    } catch (error) {
      console.log(chalk.yellow(`  ${error instanceof Error ? error.message : String(error)}`));
    }
  },
};
