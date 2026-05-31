import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TokenUsageRecord } from "./token-tracker.js";
import { getModelPricing } from "./pricing-table.js";

/**
 * クラウド/ローカル LLM の使用量を月次 jsonl に永続化し、 期間・軸別に集計するストア。
 *
 * 設計: docs/cost-token-command-design.md
 *
 * レイアウト:
 *   ~/.localllm/usage/
 *     ├── YYYY-MM.jsonl   record ごとに 1 行 append
 *     └── state.json      { firstRecordAt, windowStartAt }
 *
 * - record() からの append は best-effort (失敗は無視)。
 * - 計測窓 (windowStartAt) は /cost reset で now に更新。 履歴 jsonl は消さない。
 */

// 既定は ~/.localllm/usage。 LOCALLLM_USAGE_DIR で上書き可 (テスト/サンドボックス用)。
// 動的解決 (環境変数を呼出時に読む) にすることで、 テストが実行時に override できる。
function usageDir(): string {
  return process.env.LOCALLLM_USAGE_DIR ?? path.join(os.homedir(), ".localllm", "usage");
}
function stateFilePath(): string {
  return path.join(usageDir(), "state.json");
}

/** vitest 実行中 (VITEST 環境変数) かつ override 無指定なら、 実ユーザーデータ汚染を防ぐため書き込みを抑止。 */
function persistenceEnabled(): boolean {
  return !process.env.VITEST || !!process.env.LOCALLLM_USAGE_DIR;
}

/**
 * 期間指定。 session/window/all に加え、 任意の日 (day) / 月 (month) を指定できる。
 * - today/yesterday → { type:"day", key:"YYYY-MM-DD" }
 * - 当月/lastmonth/任意 "YYYY-MM" → { type:"month", key:"YYYY-MM" }
 */
export type PeriodSpec =
  | { type: "session" }
  | { type: "window" }
  | { type: "all" }
  | { type: "day"; key: string }
  | { type: "month"; key: string };

export type UsageGroupBy = "model" | "provider" | "slot";

interface UsageState {
  firstRecordAt?: string;
  windowStartAt?: string;
}

export interface UsageRow {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  recordCount: number;
}

export interface UsageAggregate {
  period: PeriodSpec;
  periodLabel: string;
  windowStartAt?: string;
  firstRecordAt?: string;
  rows: UsageRow[];
  grand: UsageRow;
  unpricedModels: string[];
}

// ── ファイル I/O ───────────────────────────────────────────

function ensureDir(): void {
  const dir = usageDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** ローカル時刻ベースの YYYY-MM */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** ローカル時刻ベースの YYYY-MM-DD */
function dayKey(d: Date): string {
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthFilePath(monthYYYYMM: string): string {
  return path.join(usageDir(), `${monthYYYYMM}.jsonl`);
}

export function readState(): UsageState {
  try {
    const sf = stateFilePath();
    if (fs.existsSync(sf)) {
      return JSON.parse(fs.readFileSync(sf, "utf-8")) as UsageState;
    }
  } catch {
    /* 破損時は空 state として扱う */
  }
  return {};
}

function writeState(state: UsageState): void {
  if (!persistenceEnabled()) return;
  try {
    ensureDir();
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

/** record を月次 jsonl へ append し、 state (firstRecordAt/windowStartAt) を初期化する。 best-effort。 */
export function appendUsageRecord(record: TokenUsageRecord): void {
  if (!persistenceEnabled()) return;
  try {
    ensureDir();
    const ts = record.timestamp ? new Date(record.timestamp) : new Date();
    const file = monthFilePath(monthKey(ts));
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");

    const state = readState();
    let changed = false;
    if (!state.firstRecordAt) {
      state.firstRecordAt = record.timestamp;
      changed = true;
    }
    // 初回は計測窓 = 全期間起点。 以降は /cost reset でのみ更新。
    if (!state.windowStartAt) {
      state.windowStartAt = record.timestamp;
      changed = true;
    }
    if (changed) writeState(state);
  } catch {
    /* 永続化失敗はセッション表示に影響させない */
  }
}

function listMonthFiles(): string[] {
  try {
    return fs
      .readdirSync(usageDir())
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => path.join(usageDir(), f));
  } catch {
    return [];
  }
}

function readJsonl(filePath: string): TokenUsageRecord[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as TokenUsageRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is TokenUsageRecord => r !== null);
  } catch {
    return [];
  }
}

function readAllRecords(): TokenUsageRecord[] {
  return listMonthFiles().flatMap(readJsonl);
}

// ── 期間パース ─────────────────────────────────────────────

/** YYYY-MM-DD 形式か */
function isDayKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
/** YYYY-MM 形式か */
function isMonthKey(s: string): boolean {
  return /^\d{4}-\d{2}$/.test(s);
}

function shiftDay(base: Date, deltaDays: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + deltaDays);
  return d;
}
function shiftMonth(base: Date, deltaMonths: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + deltaMonths);
  return d;
}

/**
 * コマンド引数トークンを PeriodSpec に解決する。 該当しなければ null。
 * 受理: session / window / all / today / yesterday / month(当月) / lastmonth|last-month(先月) /
 *       YYYY-MM-DD (任意日) / YYYY-MM (任意月)
 */
export function resolvePeriod(token: string): PeriodSpec | null {
  const t = token.toLowerCase();
  switch (t) {
    case "session": return { type: "session" };
    case "window": return { type: "window" };
    case "all": return { type: "all" };
    case "today": return { type: "day", key: dayKey(new Date()) };
    case "yesterday": return { type: "day", key: dayKey(shiftDay(new Date(), -1)) };
    case "month": return { type: "month", key: monthKey(new Date()) };
    case "lastmonth":
    case "last-month": return { type: "month", key: monthKey(shiftMonth(new Date(), -1)) };
  }
  if (isDayKey(t)) return { type: "day", key: t };
  if (isMonthKey(t)) return { type: "month", key: t };
  return null;
}

// ── 集計 ───────────────────────────────────────────────────

/**
 * 指定期間のレコードを取得する。
 * @param sessionRecords type="session" のとき in-memory レコードを使う (永続化失敗時のフォールバック兼用)
 */
export function loadRecords(
  spec: PeriodSpec,
  sessionRecords: readonly TokenUsageRecord[] = [],
): TokenUsageRecord[] {
  switch (spec.type) {
    case "session":
      return [...sessionRecords];
    case "all":
      return readAllRecords();
    case "month":
      return readJsonl(monthFilePath(spec.key));
    case "day": {
      // 日付の属する月ファイルを読んで当日のみ抽出
      const month = spec.key.slice(0, 7);
      return readJsonl(monthFilePath(month)).filter(
        (r) => dayKey(new Date(r.timestamp)) === spec.key,
      );
    }
    case "window": {
      const start = readState().windowStartAt;
      const all = readAllRecords();
      if (!start) return all;
      return all.filter((r) => r.timestamp >= start);
    }
  }
}

function periodLabel(spec: PeriodSpec): string {
  switch (spec.type) {
    case "session": return "今セッション";
    case "window": return "計測窓";
    case "all": return "全期間";
    case "day": {
      const today = dayKey(new Date());
      const yst = dayKey(shiftDay(new Date(), -1));
      if (spec.key === today) return `今日 (${spec.key})`;
      if (spec.key === yst) return `昨日 (${spec.key})`;
      return spec.key;
    }
    case "month": {
      const cur = monthKey(new Date());
      const last = monthKey(shiftMonth(new Date(), -1));
      if (spec.key === cur) return `今月 (${spec.key})`;
      if (spec.key === last) return `先月 (${spec.key})`;
      return spec.key;
    }
  }
}

function emptyRow(key: string): UsageRow {
  return { key, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, recordCount: 0 };
}

function addInto(row: UsageRow, r: TokenUsageRecord): void {
  row.inputTokens += r.inputTokens ?? 0;
  row.outputTokens += r.outputTokens ?? 0;
  row.cachedTokens += r.cachedTokens ?? 0;
  row.costUsd += r.estimatedCostUsd ?? 0;
  row.recordCount += 1;
}

function groupKey(r: TokenUsageRecord, groupBy: UsageGroupBy): string {
  switch (groupBy) {
    case "model":
      return r.model || "(unknown)";
    case "provider":
      return r.provider || "(unknown)";
    case "slot":
      return r.slot ?? "main";
  }
}

/** 指定期間・軸で集計する。 rows は cost 降順。 */
export function aggregate(
  spec: PeriodSpec,
  groupBy: UsageGroupBy,
  sessionRecords: readonly TokenUsageRecord[] = [],
): UsageAggregate {
  const records = loadRecords(spec, sessionRecords);
  const map = new Map<string, UsageRow>();
  const grand = emptyRow("合計");
  const unpriced = new Set<string>();

  for (const r of records) {
    const key = groupKey(r, groupBy);
    let row = map.get(key);
    if (!row) {
      row = emptyRow(key);
      map.set(key, row);
    }
    addInto(row, r);
    addInto(grand, r);
    if (r.model && getModelPricing(r.model) === null) {
      unpriced.add(r.model);
    }
  }

  const rows = [...map.values()].sort((a, b) => b.costUsd - a.costUsd);
  const state = readState();
  return {
    period: spec,
    periodLabel: periodLabel(spec),
    windowStartAt: state.windowStartAt,
    firstRecordAt: state.firstRecordAt,
    rows,
    grand,
    unpricedModels: [...unpriced],
  };
}

/** 計測窓をリセット (windowStartAt = now)。 履歴 jsonl は消さない。 */
export function resetWindow(): string {
  const state = readState();
  const now = new Date().toISOString();
  state.windowStartAt = now;
  if (!state.firstRecordAt) state.firstRecordAt = now;
  writeState(state);
  return now;
}

/**
 * 指定期間のレコードを sandbox に出力する。
 * @returns 出力先パス
 */
export function exportUsage(
  spec: PeriodSpec,
  format: "jsonl" | "csv",
  sessionRecords: readonly TokenUsageRecord[] = [],
  destDir: string = path.join(usageDir(), "exports"),
): string {
  const records = loadRecords(spec, sessionRecords);
  const stamp = dayKey(new Date());
  const specTag = spec.type === "day" || spec.type === "month" ? spec.key : spec.type;
  const outPath = path.join(destDir, `usage-export-${specTag}-${stamp}.${format}`);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  if (format === "jsonl") {
    fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  } else {
    const header = "timestamp,slot,provider,model,inputTokens,outputTokens,cachedTokens,estimatedCostUsd,sessionId";
    const lines = records.map((r) =>
      [
        r.timestamp,
        r.slot ?? "main",
        r.provider,
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.cachedTokens,
        r.estimatedCostUsd,
        r.sessionId ?? "",
      ].join(","),
    );
    fs.writeFileSync(outPath, [header, ...lines].join("\n") + "\n", "utf-8");
  }
  return outPath;
}

/** モデルの参考単価 (in/out USD per 1M)。 未登録は null。 */
export function modelUnitPrice(model: string): { input: number; output: number } | null {
  const p = getModelPricing(model);
  if (!p) return null;
  return { input: p.inputPerMToken, output: p.outputPerMToken };
}
