/**
 * /compact — コンテキストを今すぐ整理する (手動の整理はこの 1 つだけ。 docs/context-reduction-redesign.md §7 / §14.2 の 4)。
 *
 * 整理イベント (AgentLoop.runReductionEvent("manual")) を行い、 段階 0〜3 を最後まで進める
 * (段階 0〜2 は毎回最後まで、 段階 3 の要約は要約してよい最大の範囲)。 成功したら先読みする (§9)。
 * 結果 (前後の P、 段階ごとの減った量、 要約したか、 失敗の理由、 先読みの有無) を画面に出す。 表示は履歴に入れない (§8)。
 * 事前に確かめるだけの /compact dry は作らない (見込みは /context に出す)。
 */
import chalk from "chalk";
import { formatCompactResult } from "../reduction-view.js";
import type { ReplCommandDef } from "./types.js";

export const compactCommand: ReplCommandDef = {
  name: "/compact",
  summary: "コンテキストを今すぐ整理する (見込みは /context で確認)",
  completions: [{ command: "/compact", description: "コンテキストを今すぐ整理する" }],
  async handler(ctx, args) {
    if (args.length > 0) {
      console.log(chalk.yellow(`  /compact は引数を取りません: ${args.join(" ")}`));
      console.log(chalk.dim("  整理の見込みは /context で確認できます"));
      return;
    }
    // 結果の 1 行は整理イベント (AgentLoop) が出し、 ここでは内訳を出す
    const result = await ctx.agent.runReductionEvent("manual");
    process.stdout.write(formatCompactResult(result, ctx.agent.getLastReductionEvent()));
  },
};
