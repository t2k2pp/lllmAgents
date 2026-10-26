/**
 * コンテキスト整理の利用者向けの表示 (docs/context-reduction-redesign.md §7)。
 *   - formatCompactResult: /compact の結果 (前後の P、 段階ごとの減った量、 要約したか、 失敗の理由、 先読みの有無)
 *   - formatReductionStatus: /context に足す整理の状態 (P、 R の内訳、 規則 1・2 の発火点、 G、 直近の整理、 今 /compact した場合の見込み)
 *
 * どちらも画面 (と Slack / Discord の返信) に出すだけで、 履歴には入れない。 モデルに残量を伝えない (§8)。
 */
import chalk from "chalk";
import {
  type LastReductionEvent,
  type ReductionEventRecord,
  type ReductionEventResult,
  type ReductionFailureReason,
  type ReductionStatus,
  triggerLabel,
} from "../agent/reduction-event.js";
import type { PrewarmOutcome } from "../agent/prewarm.js";

const n = (v: number): string => v.toLocaleString("en-US");

function basisLabel(basis: "usage" | "estimate"): string {
  return basis === "usage" ? "サーバが返した実数をもとにした値" : "文字数からの推定";
}

function failureLabel(reason: ReductionFailureReason): string {
  switch (reason) {
    case "stages-error":
      return "段階 0〜2 の当てはめで誤りが起きました";
    case "summary-failed":
      return "要約を得られませんでした";
    case "summary-error":
      return "要約の呼び出しが失敗しました";
    case "nothing-to-reduce":
      return "減らせるものがありませんでした";
    case "still-too-large":
      return "整理しても次の呼び出しが入りません";
    case "apply-error":
      return "履歴の差し替えに失敗しました";
    default: {
      const exhaustive: never = reason;
      return String(exhaustive);
    }
  }
}

/** 段階ごとの減った量の行 (記録の freedTokens) */
function stageLines(f: ReductionEventRecord["freedTokens"] | Omit<ReductionEventRecord["freedTokens"], "stage3">) {
  const rows: Array<[string, number]> = [
    ["前の依頼の片付け (補助メッセージ・思考)", f.preprocess],
    ["段階 0 (読み直し・重複・やり直しの除去)", f.stage0],
    ["段階 1 (古いツール結果)", f.stage1],
    ["段階 2 (古い思考)", f.stage2],
  ];
  if ("stage3" in f) rows.push(["段階 3 (要約)", f.stage3]);
  return rows.map(([label, v]) => `      ${label.padEnd(28)} 約 ${n(v)}`);
}

/** 要約の行。 失敗したときは設定 context.summaryFailure に応じた結果も書く */
function summaryLine(r: ReductionEventRecord): string {
  const s = r.summary;
  switch (s.status) {
    case "done":
      return `要約: ${s.segments ?? 0} 区間を要約しました (要約の呼び出し ${s.attempts ?? 1} 回)`;
    case "not-needed":
      return "要約: しませんでした (段階 0〜2 で足りたため)";
    case "nothing-to-summarize":
      return "要約: しませんでした (要約してよい範囲がありません。 利用者の発言と直近のやり取りは残します)";
    case "failed":
    case "error": {
      const detail = s.failureDetail ?? "要約の失敗";
      if (r.continuedWithoutSummary) {
        return `要約: 失敗しました。 設定 context.summaryFailure が continue なので、 段階 0〜2 の分だけで整理しました: ${detail}`;
      }
      if (r.summaryFailurePolicy === "stop") {
        return `要約: 失敗しました。 設定 context.summaryFailure が stop なので、 整理を取りやめました: ${detail}`;
      }
      return `要約: 失敗しました: ${detail}`;
    }
    default: {
      const exhaustive: never = s.status;
      return String(exhaustive);
    }
  }
}

function prewarmLine(ok: boolean, prewarmSent: boolean, outcome: PrewarmOutcome | null): string {
  if (!ok) return "先読み: 送っていません (履歴を変えていないので、 サーバの読み込みはそのまま使えます)";
  if (outcome === null) {
    return prewarmSent
      ? "先読み: 送りました (次の呼び出しに備えて、 サーバに会話を読み込ませています。 結果は使いません)"
      : "先読み: 送っていません";
  }
  switch (outcome.status) {
    case "skipped":
      return `先読み: 送っていません (${outcome.detail})`;
    case "done":
      return `先読み: 済みました (${(outcome.durationMs / 1000).toFixed(1)} 秒)`;
    case "failed":
      return `先読み: 失敗しました (作業には影響しません): ${outcome.error}`;
    case "aborted":
      return "先読み: 途中で止めました";
    default: {
      const exhaustive: never = outcome;
      return String(exhaustive);
    }
  }
}

/**
 * /compact の結果。 1 行の結果 (整理イベントのスピナーの行) の後に出す内訳。
 * @param last AgentLoop.getLastReductionEvent() (先読みを送ったか)。 この整理のものでなければ先読みは「送っていません」
 */
export function formatCompactResult(result: ReductionEventResult, last: LastReductionEvent | null): string {
  const r = result.record;
  const prewarmSent = last !== null && last.record === r && last.prewarmSent;
  const out: string[] = [""];
  out.push(chalk.bold(`  /compact の結果 (${r.id})`));
  if (result.ok) {
    out.push(`    整理前: 約 ${n(r.promptTokensBefore)} トークン (${basisLabel(r.promptBasis)})`);
    out.push(`    整理後: 約 ${n(r.promptTokensAfter)} トークン (推定)`);
    out.push(`    減った量: 約 ${n(r.freedTokens.total)} トークン (忘却の記録の分を差し引いた値)`);
    out.push(...stageLines(r.freedTokens).map((l) => chalk.dim(l)));
    const line = summaryLine(r);
    out.push(`    ${r.continuedWithoutSummary ? chalk.yellow(line) : line}`);
  } else {
    out.push(chalk.yellow(`    結果: ${failureLabel(result.reason)}。 履歴は変えていません`));
    out.push(`    いまの量: 約 ${n(r.promptTokensBefore)} トークン (${basisLabel(r.promptBasis)})`);
    if (r.summary.status === "failed" || r.summary.status === "error") {
      // 失敗の中身は要約の行に書く (同じ文を 2 度出さない)
      out.push(`    ${summaryLine(r)}`);
    } else {
      out.push(chalk.dim(`      ${result.detail}`));
    }
  }
  out.push(`    ${prewarmLine(result.ok, prewarmSent, r.prewarm)}`);
  out.push("");
  return out.join("\n");
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function lastEventLines(last: LastReductionEvent | null): string[] {
  if (last === null) return ["    直近の整理: この会話ではまだ整理していません"];
  const r = last.record;
  const head = `    直近の整理: ${r.id} (${triggerLabel(r.trigger)}、 ${formatTime(last.finishedAt)})`;
  if (!r.ok) {
    return [
      head,
      chalk.dim(
        `      ${r.failureReason ? failureLabel(r.failureReason) : "失敗"}。 履歴は変えていません: ${r.failureDetail ?? ""}`,
      ),
    ];
  }
  const parts = [`約 ${n(r.freedTokens.total)} トークン減 (${n(r.promptTokensBefore)} → ${n(r.promptTokensAfter)})`];
  if (r.summary.status === "done") parts.push(`要約 ${r.summary.segments ?? 0} 区間`);
  if (r.continuedWithoutSummary) parts.push("要約に失敗し段階 0〜2 だけ");
  return [head, chalk.dim(`      ${parts.join("、 ")}`)];
}

/** /context に足す整理の状態 (利用者向けだけ) */
export function formatReductionStatus(s: ReductionStatus): string {
  const b = s.budget;
  const P = s.promptSize.tokens;
  const out: string[] = [];
  out.push(chalk.bold("  コンテキストの整理"));
  out.push(`    次に送る量 P: 約 ${n(P)} トークン (${basisLabel(s.promptSize.basis)})`);
  out.push(
    `    予約 R: ${n(b.reserveTokens)} = 出力の上限 O ${n(b.outputTokenLimit)} + ツール結果の合計 T ${n(b.toolResultTotalTokens)}` +
      ` + 推定の余白 M ${n(b.estimateMarginTokens)} + 整理の余白 S ${n(b.reductionMarginTokens)}`,
  );
  const distance = (limit: number): string =>
    P > limit ? chalk.yellow(`いま ${n(P - limit)} 超えています`) : `あと ${n(limit - P)}`;
  out.push("    整理する点:");
  out.push(
    `      作業の途中 (規則 1)  P が ${n(s.forcedLimitTokens)} (= W ${n(b.contextWindow)} − R) を超えたら、 次の呼び出しの前に整理 (${distance(s.forcedLimitTokens)})`,
  );
  out.push(
    `      依頼の区切り (規則 2) P が ${n(s.boundaryLimitTokens)} (= W − R − G) を超えていたら、 依頼の終わりなどの区切りで整理 (${distance(s.boundaryLimitTokens)})`,
  );
  const g = s.growth;
  const source = g.source === "default" ? "既定値。 直近の依頼が 3 件そろうまで" : "直近 3 件の依頼で増えた量の最大";
  const capped = g.capped ? `。 (W − R) ÷ 2 = ${n(g.capTokens)} で頭打ち` : "";
  out.push(`    ひと仕事の増分 G: ${n(g.tokens)} (${source}${capped})`);
  out.push(
    `      直近の依頼で増えた量: ${s.recentGrowths.length > 0 ? s.recentGrowths.map((v) => n(v)).join(" / ") : "まだ記録がありません"}`,
  );
  out.push(...lastEventLines(s.lastEvent));

  out.push("    今 /compact した場合の見込み (要約は呼ばずに数えた値):");
  const p = s.preview;
  if (!p.ok) {
    out.push(chalk.red(`      見込みを出せませんでした: ${p.error}`));
  } else {
    out.push(...stageLines(p.freedTokens).map((l) => chalk.dim(l)));
    out.push(
      `      段階 0〜2 の後: 約 ${n(p.promptTokensAfterStages)} トークン (目標は ${n(p.goal.targetPromptTokens)} 以下、 最低 ${n(p.goal.minimumReductionTokens)} 減らす)`,
    );
    if (p.needsSummary) {
      out.push(
        `      段階 0〜2 だけでは足りません (目標まで ${n(p.shortfall.toTarget)}、 最低量まで ${n(p.shortfall.toMinimum)} 不足)。 自動の整理でも要約します`,
      );
    } else {
      out.push("      段階 0〜2 だけで目標と最低量に届きます (自動の整理なら要約しません)");
    }
    if (p.summary.status === "would-summarize") {
      out.push(
        `      段階 3 (要約): /compact では ${p.summary.segments} 区間を要約します (LLM を呼びます。 見込み 約 ${n(p.summary.estimatedFreedTokens)} 減)`,
      );
    } else {
      out.push(`      段階 3 (要約): 要約してよい範囲がありません (${p.summary.detail})`);
    }
    out.push(
      chalk.dim(
        `      直近 ${s.keepRecentToolUses} 回のツール呼び出しと利用者の発言は残します。 要約に失敗したとき: ${s.summaryFailurePolicy === "continue" ? "段階 0〜2 の分だけで整理 (continue)" : "整理を取りやめる (stop)"}`,
      ),
    );
  }
  out.push("");
  return out.join("\n");
}
