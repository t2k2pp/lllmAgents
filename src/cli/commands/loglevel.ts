/**
 * /loglevel — 運用ログ (ops-logger) のレベル確認・変更。
 * レジストリ移設 (PR-10)。挙動は旧 repl.ts switch 実装と同一。
 */
import chalk from "chalk";
import { getOpsLogger, setOpsLogLevel, parseOpsLogLevel } from "../../utils/ops-logger.js";
import type { ReplCommandDef } from "./types.js";

export const loglevelCommand: ReplCommandDef = {
  name: "/loglevel",
  summary: "運用ログのレベル確認・変更 (trace/debug/info/warn/error)",
  completions: [
    { command: "/loglevel", description: "運用ログのレベル確認・変更 (trace/debug/info/warn/error)" },
  ],
  handler(_ctx, args) {
    const opsLogger = getOpsLogger();
    const filePath = opsLogger.getFilePath();
    if (args.length === 0) {
      console.log(chalk.dim(`  運用ログ level: ${opsLogger.getLevel()}`));
      console.log(chalk.dim(`  出力先: ${filePath ?? "(disabled)"}`));
      console.log(chalk.dim("  変更: /loglevel [trace|debug|info|warn|error]"));
      return;
    }
    const level = parseOpsLogLevel(args[0]);
    if (!level) {
      console.log(chalk.yellow("  無効な level。 trace|debug|info|warn|error から選択してください。"));
      return;
    }
    setOpsLogLevel(level);
    console.log(chalk.dim(`  運用ログ level を ${level} に変更しました (このセッションのみ)`));
  },
};
