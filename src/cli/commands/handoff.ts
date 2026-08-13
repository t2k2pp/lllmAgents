/**
 * /handoff — 引き継ぎメモを残してコンテキストをリセットする (docs/context-strategy.md §5.3)。
 *
 *   /handoff       引き継ぎメモを作ってコンテキストをリセット
 *   /handoff dry   引き継ぎメモを作って表示するだけ (リセットしない)
 *
 * 自動検出 (区切りシグナル) はあくまで補助で、 「今ここで区切りたい」 という判断は
 * ユーザーが一番正確にできる。 だから独立したコマンドとして置く。
 *
 * 引き継ぎ無しで完全に消したい場合は従来通り /clear を使う。
 */
import chalk from "chalk";
import type { ReplCommandDef, ReplCommandContext } from "./types.js";

/** 引き継ぎメモを枠付きで全文表示する。 何が引き継がれたかを見せずに履歴は消さない */
function printNote(note: string): void {
  console.log(chalk.bold("\n  === 引き継ぎメモ ==="));
  for (const line of note.split("\n")) console.log(`  ${line}`);
  console.log("");
}

async function runDry(ctx: ReplCommandContext): Promise<void> {
  console.log(chalk.dim("  引き継ぎメモを作成中 (リセットはしません)..."));
  const { note, reason } = await ctx.agent.buildHandoffPreview();
  if (!note) {
    console.log(chalk.yellow(`  引き継ぎメモを作れませんでした: ${reason ?? "理由不明"}`));
    return;
  }
  printNote(note);
  console.log(chalk.dim("  この内容でリセットするには /handoff を実行してください。\n"));
}

async function runHandoff(ctx: ReplCommandContext): Promise<void> {
  console.log(chalk.dim("  引き継ぎメモを作成中..."));
  const outcome = await ctx.agent.runHandoffNow();
  if (!outcome.applied) {
    // メモを作れなかった場合は履歴に触れていない (docs §8)
    console.log(chalk.yellow(`  リセットしませんでした: ${outcome.note ?? "引き継ぎメモを生成できませんでした"}`));
    console.log(chalk.dim("  履歴は変更していません。 忘却なら /forget、 圧縮なら /compact を使ってください。"));
    return;
  }
  const note = outcome.handoff?.note;
  if (note) printNote(note);
  console.log(
    chalk.green(
      `  コンテキストをリセットしました (約 ${outcome.freedTokens.toLocaleString("en-US")} トークン削減、 ` +
        `使用率 ${Math.round(outcome.beforeRatio * 100)}% → ${Math.round(outcome.afterRatio * 100)}%)`,
    ),
  );
  if (outcome.handoff?.savedSessionId) {
    console.log(chalk.dim(`  リセット前の完全な履歴: /resume ${outcome.handoff.savedSessionId}`));
  }
  console.log("");
}

export const handoffCommand: ReplCommandDef = {
  name: "/handoff",
  summary: "引き継ぎメモを残してコンテキストをリセット（/handoff dry で事前確認）",
  completions: [
    { command: "/handoff", description: "引き継ぎメモを残してコンテキストをリセット" },
    { command: "/handoff dry", description: "引き継ぎメモを表示するだけ（リセットしない）" },
  ],
  async handler(ctx, args) {
    const sub = args[0]?.trim().toLowerCase() ?? "";
    if (sub === "dry") {
      await runDry(ctx);
      return;
    }
    if (sub.length > 0) {
      console.log(chalk.yellow(`  不明なサブコマンド: ${sub}`));
      console.log(chalk.dim("  使い方: /handoff [dry]"));
      return;
    }
    await runHandoff(ctx);
  },
};
