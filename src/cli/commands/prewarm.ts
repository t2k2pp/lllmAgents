/**
 * /prewarm — 今の会話を今のうちにサーバへ読み込ませる (先読み。 docs/context-reduction-redesign.md §9)。
 *
 * - `/prewarm`        今すぐ先読みする。 送る前に次の依頼の始まりと同じ判定をし、 整理するなら先に整理する (§9.4)。
 *                      判定と整理の間は Esc で切れる。 先読みは裏で続き、 入力欄が空のときの Esc で取り消せる
 * - `/prewarm on|off` 自動の先読み (依頼の終わりの整理・/compact・再開の後) を入れる・切る。 設定 context.prewarm.auto に保存する
 * - `/prewarm status` 自動の入切・走っている先読み (経過時間・送る量の見込み)・直近の結果
 *
 * 自動の先読みは既定で切 (思わぬときに長い読み込みが始まり、 本体の読み込みと見分けられなかった。 2026-10-27 利用者の判断)。
 * 使いどころ: 起動して再開した後、 席を外す前に /prewarm しておくと、 戻ったときの最初の呼び出しが速い。
 */
import chalk from "chalk";
import type { PrewarmOutcome } from "../../agent/prewarm.js";
import { formatElapsedJa, formatPrewarmEnd, formatTokenCount } from "../prewarm-indicator.js";
import type { ReplCommandContext, ReplCommandDef } from "./types.js";

const TRIGGER_LABELS: Record<string, string> = {
  "request-end": "依頼の終わりの整理の後 (自動)",
  manual: "/compact の後 (自動)",
  resume: "再開の後 (自動)",
  "manual-command": "/prewarm",
};

function describeOutcome(outcome: PrewarmOutcome): string {
  if (outcome.status === "failed") return `失敗しました: ${outcome.error}`;
  if (outcome.status === "skipped") return `送りませんでした: ${outcome.detail}`;
  return formatPrewarmEnd(outcome) ?? outcome.status;
}

/** /prewarm status の表示 (試験から呼ぶ) */
export function formatPrewarmStatusReport(
  status: ReturnType<ReplCommandContext["agent"]["getPrewarmStatus"]>,
  now: number = Date.now(),
): string {
  const lines = [`  自動の先読み: ${status.auto ? "入 (/prewarm off で切る)" : "切 (/prewarm on で入れる)"}`];
  if (status.running === null) {
    lines.push("  いま走っている先読み: なし");
  } else {
    const r = status.running;
    const size = r.promptTokens > 0 ? `約 ${formatTokenCount(r.promptTokens)} トークン、 ` : "";
    const waiting = r.waitingFor !== null ? `。 ${r.waitingFor}が終わりを待っています` : "";
    lines.push(
      `  いま走っている先読み: ${TRIGGER_LABELS[r.trigger] ?? r.trigger}、 ${size}${formatElapsedJa(now - r.startedAt)} 経過${waiting} (入力欄が空のときの Esc で取り消し)`,
    );
  }
  if (status.last === null) {
    lines.push("  直近の先読み: まだありません");
  } else {
    const l = status.last;
    lines.push(
      `  直近の先読み: ${TRIGGER_LABELS[l.trigger] ?? l.trigger}、 ${new Date(l.finishedAt).toLocaleTimeString()} — ${describeOutcome(l.outcome)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function setAuto(ctx: ReplCommandContext, on: boolean): void {
  ctx.config.context = { ...ctx.config.context, prewarm: { ...ctx.config.context?.prewarm, auto: on } };
  ctx.saveConfig();
  console.log(
    on
      ? chalk.green("  自動の先読み 入 (設定に保存)。 依頼の終わりの整理・/compact・再開の後に先読みします")
      : chalk.yellow("  自動の先読み 切 (設定に保存)。 先読みは /prewarm で送ります"),
  );
}

export const prewarmCommand: ReplCommandDef = {
  name: "/prewarm",
  summary: "今の会話をサーバに読み込ませる (先読み)。 on/off で自動の先読み、 status で様子",
  completions: [
    { command: "/prewarm", description: "今の会話を今のうちにサーバへ読み込ませる (先読み)" },
    { command: "/prewarm on", description: "自動の先読み (整理・再開の後) を入れる" },
    { command: "/prewarm off", description: "自動の先読みを切る (既定)" },
    { command: "/prewarm status", description: "自動の入切・走っている先読み・直近の結果" },
  ],
  async handler(ctx, args) {
    const sub = args[0];
    if (sub === "on" || sub === "off") {
      setAuto(ctx, sub === "on");
      return;
    }
    if (sub === "status") {
      process.stdout.write(formatPrewarmStatusReport(ctx.agent.getPrewarmStatus()));
      return;
    }
    if (sub !== undefined) {
      console.log(chalk.yellow(`  /prewarm の引数が分かりません: ${args.join(" ")} (on / off / status)`));
      return;
    }
    const started = ctx.agent.prewarmNow();
    if (!started.ok) {
      console.log(chalk.yellow(`  先読みしません: ${started.message}`));
      return;
    }
    // 送る前の判定と整理の間は、 通常の依頼と同じく Esc を受け付ける。 先読みそのものは裏で続く
    if (ctx.awaitRunContinuation) await ctx.awaitRunContinuation(started.prepared);
    else await started.prepared;
  },
};
