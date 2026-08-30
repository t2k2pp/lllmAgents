import chalk from "chalk";
import type { ReplCommandDef } from "./types.js";

export const renameCommand: ReplCommandDef = {
  name: "/rename",
  summary: "現在のsessionへ識別しやすい名前を保存",
  completions: [{ command: "/rename", description: "現在のsession名を変更", needsArg: true }],
  handler(ctx, args) {
    const requested = args.join(" ");
    if (!requested.trim()) {
      console.log(chalk.yellow("  使い方: /rename <session name>"));
      return;
    }
    try {
      const title = ctx.agent.renameCurrentSession(requested);
      console.log(chalk.green(`  session名を変更しました: ${title}`));
      console.log(chalk.dim(`  /resume list の一覧とsession pickerへ反映済みです。`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`  /rename失敗: ${message}`));
    }
  },
};
