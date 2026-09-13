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
import * as fs from "node:fs";
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

async function runHandoff(ctx: ReplCommandContext, providedNote?: string): Promise<void> {
  console.log(
    chalk.dim(
      providedNote === undefined
        ? "  引き継ぎメモを作成中..."
        : "  ファイルから引き継ぎます (LLM呼び出しなし)。完全履歴を別セッションへ保存します。",
    ),
  );
  const outcome = await ctx.agent.runHandoffNow(providedNote);
  if (!outcome.applied) {
    // メモを作れなかった場合は履歴に触れていない (docs §8)
    console.log(chalk.yellow(`  リセットしませんでした: ${outcome.note ?? "引き継ぎメモを生成できませんでした"}`));
    console.log(
      chalk.dim(
        "  履歴は変更していません。 保存済みメモを使う場合は /handoff from-file <path> でLLMを呼ばずに再開できます。",
      ),
    );
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
    { command: "/handoff from-file", description: "保存済みメモからLLMを呼ばずに引き継ぐ" },
    { command: "/handoff", description: "引き継ぎメモを残してコンテキストをリセット" },
    { command: "/handoff dry", description: "引き継ぎメモを表示するだけ（リセットしない）" },
  ],
  async handler(ctx, args) {
    const sub = args[0]?.trim().toLowerCase() ?? "";
    if (sub === "dry") {
      await runDry(ctx);
      return;
    }
    if (sub === "from-file") {
      const file = args
        .slice(1)
        .join(" ")
        .replace(/^(["'])(.*)\1$/, "$2");
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 64_000) throw new Error("64KB以下のUTF-8メモファイルを指定してください");
        const note = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
        await runHandoff(ctx, note);
      } catch (error) {
        console.log(chalk.yellow(`  ファイル引き継ぎに失敗しました: ${String(error)}`));
      }
      return;
    }
    if (sub.length > 0) {
      console.log(chalk.yellow(`  不明なサブコマンド: ${sub}`));
      console.log(chalk.dim("  使い方: /handoff [dry | from-file <path>]"));
      return;
    }
    await runHandoff(ctx);
  },
};
