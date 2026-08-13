/**
 * /forget — 忘却によるコンテキスト縮約 (docs/context-forgetting.md §8)。
 * `/compact` (圧縮) と対になるコマンド。
 *
 *   /forget                            今すぐ忘却を実行
 *   /forget dry                        プランだけ出して適用しない
 *   /forget mode [compress|forget|hybrid]  縮約手段の切替 (引数なしで現在値)
 *   /forget status                     現在の mode / 直近の忘却実績
 */
import chalk from "chalk";
import type { ReductionMode } from "../../config/types.js";
import type { ForgetPlan } from "../../agent/forgetting.js";
import type { ReplCommandDef, ReplCommandContext } from "./types.js";

const MODES: ReductionMode[] = ["compress", "forget", "hybrid"];

const MODE_DESCRIPTIONS: Record<ReductionMode, string> = {
  compress: "常に要約圧縮 (従来動作)",
  forget: "常に忘却。 失敗した回だけ圧縮に切り替え",
  hybrid: "まず忘却、 削減が足りなければ続けて圧縮 (既定)",
};

function isReductionMode(value: string): value is ReductionMode {
  return (MODES as string[]).includes(value);
}

/** プランの中身を「何が消えるか」 が分かる形で表示する */
function printPlan(plan: ForgetPlan): void {
  const byIndex = new Map(plan.segments.map((s) => [s.index, s]));
  console.log(chalk.dim(`  目標: 約 ${plan.targetTokens.toLocaleString("en-US")} トークン削減`));
  console.log(chalk.dim(`  見込み: 約 ${plan.estimatedFreedTokens.toLocaleString("en-US")} トークン削減`));
  if (plan.reason) console.log(chalk.dim(`  理由: ${plan.reason}`));

  for (const idx of plan.thin) {
    const s = byIndex.get(idx);
    console.log(
      chalk.yellow(`  thin #${idx}`) + chalk.dim(` ${s?.tokens.toLocaleString("en-US") ?? "?"}t  ${s?.digest ?? ""}`),
    );
  }
  for (const idx of plan.drop) {
    const s = byIndex.get(idx);
    console.log(
      chalk.red(`  drop #${idx}`) + chalk.dim(` ${s?.tokens.toLocaleString("en-US") ?? "?"}t  ${s?.digest ?? ""}`),
    );
  }
  if (plan.thin.length === 0 && plan.drop.length === 0) {
    console.log(chalk.dim("  忘却対象なし"));
  }
  // 検証で弾いた内容も黙って捨てない
  for (const w of plan.warnings) {
    console.log(chalk.yellow(`  ⚠ ${w}`));
  }
}

function showMode(ctx: ReplCommandContext): void {
  const mode = ctx.agent.getReductionMode();
  console.log(chalk.dim(`  縮約手段: ${chalk.cyan(mode)} — ${MODE_DESCRIPTIONS[mode]}`));
  console.log(chalk.dim("  変更: /forget mode [compress|forget|hybrid]"));
}

async function runForget(ctx: ReplCommandContext): Promise<void> {
  console.log(chalk.dim("  忘却するセグメントを選定中..."));
  const result = await ctx.agent.forceForget();
  if (!result.applied) {
    console.log(chalk.yellow(`  忘却は適用されませんでした: ${result.reason ?? "理由不明"}`));
    console.log(chalk.dim("  圧縮したい場合は /compact を使ってください。"));
    return;
  }
  console.log(
    chalk.green(
      `  忘却しました: thin ${result.thinnedSegments} / drop ${result.droppedSegments}、 ` +
        `約 ${result.freedTokens.toLocaleString("en-US")} トークン削減`,
    ),
  );
  if (result.plan?.reason) console.log(chalk.dim(`  理由: ${result.plan.reason}`));
  for (const w of result.plan?.warnings ?? []) {
    console.log(chalk.yellow(`  ⚠ ${w}`));
  }
  console.log(chalk.dim("  何を消したかは履歴の [忘却の記録] に残っています。"));
}

export const forgetCommand: ReplCommandDef = {
  name: "/forget",
  summary: "コンテキストを忘却で整理（/forget dry で事前確認）",
  completions: [
    { command: "/forget", description: "コンテキストを忘却で整理" },
    { command: "/forget dry", description: "忘却プランだけ表示（適用しない）" },
    { command: "/forget mode", description: "縮約手段の切替 (compress|forget|hybrid)", needsArg: true },
    { command: "/forget status", description: "現在の縮約手段と直近の忘却実績" },
  ],
  async handler(ctx, args) {
    const sub = args[0]?.trim().toLowerCase() ?? "";

    if (sub === "dry") {
      console.log(chalk.dim("  忘却プランを作成中 (適用はしません)..."));
      const report = await ctx.agent.forgetDryRun();
      console.log(chalk.dim("\n  --- 履歴一覧 ---"));
      for (const line of report.manifest.split("\n")) console.log(chalk.dim(`  ${line}`));
      console.log(chalk.dim("  --- 忘却プラン ---"));
      if (!report.plan) {
        console.log(chalk.yellow(`  プランを作れませんでした: ${report.reason ?? "理由不明"}`));
        return;
      }
      printPlan(report.plan);
      console.log(chalk.dim("  適用するには /forget を実行してください。\n"));
      return;
    }

    if (sub === "mode") {
      const value = args[1]?.trim().toLowerCase();
      if (!value) {
        showMode(ctx);
        return;
      }
      if (!isReductionMode(value)) {
        console.log(chalk.yellow(`  不明な mode: ${value}`));
        console.log(chalk.dim(`  指定できる値: ${MODES.join(" | ")}`));
        return;
      }
      ctx.agent.setReductionMode(value);
      ctx.config.context.reduction = value;
      ctx.saveConfig();
      console.log(chalk.green(`  縮約手段を ${value} に設定しました (設定に保存)`));
      console.log(chalk.dim(`  ${MODE_DESCRIPTIONS[value]}`));
      return;
    }

    if (sub === "status") {
      showMode(ctx);
      const last = ctx.agent.getLastForgetResult();
      if (!last) {
        console.log(chalk.dim("  直近の忘却: なし"));
        return;
      }
      const when = new Date(last.at).toLocaleString("ja-JP");
      if (last.result.applied) {
        console.log(
          chalk.dim(
            `  直近の忘却: ${when} — thin ${last.result.thinnedSegments} / drop ${last.result.droppedSegments}、 ` +
              `約 ${last.result.freedTokens.toLocaleString("en-US")} トークン削減`,
          ),
        );
      } else {
        console.log(chalk.dim(`  直近の忘却: ${when} — 未適用 (${last.result.reason ?? "理由不明"})`));
      }
      return;
    }

    if (sub.length > 0) {
      console.log(chalk.yellow(`  不明なサブコマンド: ${sub}`));
      console.log(chalk.dim("  使い方: /forget [dry|mode|status]"));
      return;
    }

    await runForget(ctx);
  },
};
