import chalk from "chalk";
import { getDisplayWidth } from "./interactive-input.js";
import type { TokenUsageRecord } from "../cost/token-tracker.js";
import {
  aggregate,
  modelUnitPrice,
  type UsageAggregate,
  type PeriodSpec,
  type UsageRow,
} from "../cost/usage-store.js";

/**
 * /cost コマンドの表示フォーマッタ。 各関数は表示行 (string[]) を返す (テスト容易性のため)。
 * 設計: docs/cost-token-command-design.md §5
 */

function fmtTok(n: number): string {
  return n.toLocaleString();
}

function fmtUsd(n: number): string {
  return "$" + n.toFixed(4);
}

/**
 * コスト金額を整形する。 jpyPerUsd (1ドルあたりの円) が設定されていれば「円のみ」、
 * 未設定ならドルのみを返す (どちらか一方。 設計: docs/cost-token-command-design.md)。
 */
export function fmtMoney(usd: number, jpyPerUsd?: number): string {
  if (jpyPerUsd && jpyPerUsd > 0) {
    return "¥" + Math.round(usd * jpyPerUsd).toLocaleString();
  }
  return fmtUsd(usd);
}

function fmtDate(iso?: string): string {
  if (!iso) return "(記録なし)";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** ISO 文字列から相対経過を簡易表示 (例: "3日2時間") */
function sinceLabel(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}分`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間`;
  const day = Math.floor(hr / 24);
  return `${day}日${hr % 24}時間`;
}

/** 列幅を揃えてテーブル行を組む。 header と rows[].cells は同じ列数。 数値列は右寄せ。
 *  CJK 全角を 2 桁として数える getDisplayWidth で桁揃えする (合計/未登録 等の日本語ラベル対応)。 */
function renderTable(header: string[], rows: string[][], rightAlign: boolean[]): string[] {
  const widths = header.map((h, i) =>
    Math.max(getDisplayWidth(h), ...rows.map((r) => getDisplayWidth(r[i] ?? ""))),
  );
  const padCell = (s: string, i: number): string => {
    const fill = " ".repeat(Math.max(0, widths[i] - getDisplayWidth(s)));
    return rightAlign[i] ? fill + s : s + fill;
  };
  const line = (cells: string[]): string => "  " + cells.map((c, i) => padCell(c, i)).join("  ");
  const out: string[] = [];
  out.push(chalk.dim(line(header)));
  const sep = widths.map((w) => "─".repeat(w));
  out.push(chalk.dim(line(sep)));
  for (const r of rows) out.push(chalk.dim(line(r)));
  return out;
}

function windowHeaderLine(agg: UsageAggregate): string {
  if (agg.period.type === "window") {
    const since = sinceLabel(agg.windowStartAt);
    return `計測窓: ${fmtDate(agg.windowStartAt)} 〜 現在${since ? ` (${since})` : ""}`;
  }
  return agg.periodLabel;
}

/** /cost (引数なし): サマリ */
export function formatSummary(
  period: PeriodSpec,
  sessionRecords: readonly TokenUsageRecord[],
  jpyPerUsd?: number,
): string[] {
  const agg = aggregate(period, "model", sessionRecords);
  const g = agg.grand;
  const out: string[] = [];
  out.push(chalk.bold(`\n  === Cost — サマリ (${windowHeaderLine(agg)}) ===`));
  if (agg.firstRecordAt) {
    out.push(chalk.dim(`  全期間の起点: ${fmtDate(agg.firstRecordAt)}`));
  }
  if (g.recordCount === 0) {
    out.push(chalk.dim("  この期間の記録はありません。"));
    out.push(chalk.dim("  期間切替: /cost today|yesterday|month|lastmonth|all|session または YYYY-MM-DD / YYYY-MM   詳細: /cost models | providers"));
    return out;
  }
  out.push(
    chalk.dim(
      `  Requests: ${g.recordCount}  /  in=${fmtTok(g.inputTokens)}  out=${fmtTok(g.outputTokens)}` +
        `  cached=${fmtTok(g.cachedTokens)}  /  estimated: ${chalk.white(fmtMoney(g.costUsd, jpyPerUsd))}`,
    ),
  );
  const top = agg.rows.slice(0, 3);
  if (top.length > 0) {
    out.push(chalk.dim("  上位モデル:"));
    for (const r of top) {
      const pct = g.costUsd > 0 ? Math.round((r.costUsd / g.costUsd) * 100) : 0;
      out.push(chalk.dim(`    ${r.key.padEnd(20)} ${fmtMoney(r.costUsd, jpyPerUsd)}  (${pct}%)`));
    }
  }
  // 画像生成 (slot="image") があれば枚数とコストを別行で表示 (docs/image-generation.md §6.3)
  if (g.imageCount > 0) {
    const bySlot = aggregate(period, "slot", sessionRecords);
    const imageRow = bySlot.rows.find((r) => r.key === "image");
    if (imageRow) {
      out.push(chalk.dim(`  画像生成: ${imageRow.imageCount}枚  ${fmtMoney(imageRow.costUsd, jpyPerUsd)}`));
    }
  }
  if (agg.unpricedModels.length > 0) {
    out.push(chalk.yellow(`  ⚠ 単価未登録: ${agg.unpricedModels.join(", ")} (cost=0 で計上)`));
  }
  out.push(chalk.dim("  期間切替: /cost today|yesterday|month|lastmonth|all|session または YYYY-MM-DD / YYYY-MM   詳細: /cost models | providers"));
  return out;
}

function modelRow(r: UsageRow, jpyPerUsd?: number): string[] {
  const price = modelUnitPrice(r.key);
  // 表内セルは色を付けない (chalk の ANSI が getDisplayWidth の桁計算を崩すため)。 強調は下の警告行で行う。
  const unit = price ? `${price.input.toFixed(2)} / ${price.output.toFixed(2)}` : "未登録 ⚠";
  return [
    r.key,
    String(r.recordCount),
    fmtTok(r.inputTokens),
    fmtTok(r.outputTokens),
    fmtTok(r.cachedTokens),
    fmtMoney(r.costUsd, jpyPerUsd),
    unit,
  ];
}

/** /cost models: モデル別テーブル */
export function formatModels(
  period: PeriodSpec,
  sessionRecords: readonly TokenUsageRecord[],
  jpyPerUsd?: number,
): string[] {
  const agg = aggregate(period, "model", sessionRecords);
  const out: string[] = [];
  out.push(chalk.bold(`\n  === Cost — モデル別 (${windowHeaderLine(agg)}) ===`));
  if (agg.grand.recordCount === 0) {
    out.push(chalk.dim("  この期間の記録はありません。"));
    return out;
  }
  // 単価列は USD 据え置き。 cost 列のみレート設定時に円表示になるためヘッダで明示する。
  const costHeader = jpyPerUsd && jpyPerUsd > 0 ? "cost(¥)" : "cost";
  const header = ["model", "req", "in", "out", "cached", costHeader, "単価(in/out $/M)"];
  const right = [false, true, true, true, true, true, false];
  const rows = agg.rows.map((r) => modelRow(r, jpyPerUsd));
  rows.push([
    "合計",
    String(agg.grand.recordCount),
    fmtTok(agg.grand.inputTokens),
    fmtTok(agg.grand.outputTokens),
    fmtTok(agg.grand.cachedTokens),
    fmtMoney(agg.grand.costUsd, jpyPerUsd),
    "",
  ]);
  out.push(...renderTable(header, rows, right));
  if (agg.unpricedModels.length > 0) {
    out.push(
      chalk.yellow(
        `  ⚠ 単価未登録: ${agg.unpricedModels.join(", ")} (cost=0 で計上)。 ~/.localllm/pricing.json に追記可`,
      ),
    );
  }
  out.push(
    chalk.dim("  算出: cost = in×単価in/1M + out×単価out/1M (cached は cachedInputPerMToken 適用)"),
  );
  return out;
}

function axisTable(agg: UsageAggregate, title: string, jpyPerUsd?: number): string[] {
  const out: string[] = [];
  out.push(chalk.dim(`  ── ${title} ──`));
  const costHeader = jpyPerUsd && jpyPerUsd > 0 ? "cost(¥)" : "cost";
  const header = ["key", "req", "in", "out", "cached", costHeader];
  const right = [false, true, true, true, true, true];
  const rows = agg.rows.map((r) => [
    r.key,
    String(r.recordCount),
    fmtTok(r.inputTokens),
    fmtTok(r.outputTokens),
    fmtTok(r.cachedTokens),
    fmtMoney(r.costUsd, jpyPerUsd),
  ]);
  out.push(...renderTable(header, rows, right));
  return out;
}

/** /cost providers: provider 別 + slot 別 */
export function formatProviders(
  period: PeriodSpec,
  sessionRecords: readonly TokenUsageRecord[],
  jpyPerUsd?: number,
): string[] {
  const byProvider = aggregate(period, "provider", sessionRecords);
  const bySlot = aggregate(period, "slot", sessionRecords);
  const out: string[] = [];
  out.push(chalk.bold(`\n  === Cost — provider / slot 別 (${windowHeaderLine(byProvider)}) ===`));
  if (byProvider.grand.recordCount === 0) {
    out.push(chalk.dim("  この期間の記録はありません。"));
    return out;
  }
  out.push(...axisTable(byProvider, "provider 別", jpyPerUsd));
  out.push("");
  out.push(...axisTable(bySlot, "slot 別 (main / second / vision / image)", jpyPerUsd));
  return out;
}
