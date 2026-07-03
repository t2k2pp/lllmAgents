/**
 * /autorun — 自律実行モード (非破壊操作の自動許可) の切り替え。
 * レジストリ移設 (PR-10)。挙動は旧 repl.ts switch 実装と同一。
 */
import chalk from "chalk";
import type { ReplCommandDef, ReplCommandContext } from "./types.js";

function setAutorun(ctx: ReplCommandContext, on: boolean): void {
  ctx.agent.getPermissions().setAutorunMode(on);
  ctx.config.autorunMode = on;
  ctx.saveConfig();
  if (on) {
    console.log(chalk.green("  自律実行モード ON (設定に保存)"));
    console.log(chalk.dim("  作業フォルダ内の操作は削除以外すべて自動承認されます"));
    console.log(chalk.dim("  中断: Ctrl+C / 停止: /autorun off"));
  } else {
    console.log(chalk.yellow("  自律実行モード OFF (設定に保存)"));
  }
}

export const autorunCommand: ReplCommandDef = {
  name: "/autorun",
  summary: "Autorunモード切り替え（非破壊操作の自動許可）",
  completions: [{ command: "/autorun", description: "Autorunモード切り替え（非破壊操作の自動許可）" }],
  handler(ctx, args) {
    const sub = args[0];
    if (sub === "on") {
      setAutorun(ctx, true);
    } else if (sub === "off") {
      setAutorun(ctx, false);
    } else {
      setAutorun(ctx, !ctx.agent.getPermissions().isAutorunMode());
    }
  },
};
