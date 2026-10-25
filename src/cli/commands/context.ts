/**
 * /context — コンテキストの使用状況 (docs/context-reduction-redesign.md §7)。
 *
 *   /context            カテゴリ別の内訳 + 整理の状態 (P、 R の内訳、 規則 1・2 の発火点、 G と直近 3 件、
 *                       直近の整理イベント、 今 /compact した場合の段階ごとの減る量の見込み)
 *   /context <section>  そのカテゴリの中身を出す (system | memory | skills | tools [name] | messages)
 *
 * 表示は利用者向けだけで、 履歴には入れない (モデルに残量を伝えない。 §8)。
 */
import chalk from "chalk";
import {
  buildContextBreakdown,
  formatContextBreakdown,
  formatContextDetail,
  normalizeContextSection,
} from "../context-breakdown.js";
import { formatReductionStatus } from "../reduction-view.js";
import type { ReplCommandDef } from "./types.js";

export const contextCommand: ReplCommandDef = {
  name: "/context",
  summary: "コンテキストの内訳と整理の状態・見込み (引数で中身を表示: system|memory|skills|tools|messages)",
  completions: [
    {
      command: "/context",
      description: "コンテキストの内訳と整理の状態 (P・予約・整理する点・今 /compact した場合の見込み)",
    },
    { command: "/context system", description: "システムプロンプト本文の内訳をダンプ" },
    { command: "/context memory", description: "メモ・プロジェクト指示の本文をダンプ" },
    { command: "/context skills", description: "注入中スキル一覧 (trigger/description) をダンプ" },
    {
      command: "/context tools",
      description: "ツール定義をトークン降順で一覧 (/context tools <name> で全文スキーマ)",
      needsArg: true,
    },
    { command: "/context messages", description: "会話履歴をメッセージ単位でダンプ" },
  ],
  handler(ctx, args) {
    const sectionArg = args[0]?.trim();
    if (sectionArg) {
      const section = normalizeContextSection(sectionArg);
      if (!section) {
        console.log(chalk.yellow(`  不明な section: ${sectionArg}`));
        console.log(chalk.dim("  使い方: /context [system|memory|skills|tools|messages]"));
        return;
      }
      process.stdout.write(formatContextDetail(ctx.agent, ctx.skillRegistry, section, process.cwd(), args[1]?.trim()));
      return;
    }
    const breakdown = buildContextBreakdown(ctx.agent, ctx.skillRegistry, ctx.mcpManager);
    process.stdout.write(formatContextBreakdown(breakdown));
    process.stdout.write(formatReductionStatus(ctx.agent.getReductionStatus()));
  },
};
