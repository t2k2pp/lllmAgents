/**
 * /parallel — ツール並列実行数の確認・変更。
 * 旧 repl.ts switch からのレジストリ移設第1号 (PR-10)。
 */
import chalk from "chalk";
import type { ReplCommandDef } from "./types.js";

export const parallelCommand: ReplCommandDef = {
  name: "/parallel",
  summary: "並列ツール実行数の確認・変更",
  completions: [{ command: "/parallel", description: "並列ツール実行数の確認・変更", needsArg: true }],
  handler(ctx, args) {
    const n = parseInt(args[0], 10);
    if (Number.isNaN(n)) {
      console.log(chalk.dim(`  現在の並列実行上限: ${ctx.agent.getMaxParallelTools()}`));
      console.log(chalk.dim("  変更: /parallel <数値>"));
    } else {
      ctx.agent.setMaxParallelTools(n);
      ctx.config.maxParallelTools = ctx.agent.getMaxParallelTools();
      ctx.saveConfig();
      console.log(chalk.green(`  並列実行上限を ${ctx.agent.getMaxParallelTools()} に設定しました (設定に保存)`));
    }
  },
};
