import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TokenUsageRecord } from "../../src/cost/token-tracker.js";
import {
  resolvePeriod,
  aggregate,
  loadRecords,
  appendUsageRecord,
  resetWindow,
  readState,
  type PeriodSpec,
} from "../../src/cost/usage-store.js";

function rec(o: Partial<TokenUsageRecord>): TokenUsageRecord {
  return {
    timestamp: new Date().toISOString(),
    provider: "azure-gpt",
    model: "gpt-5.4",
    slot: "main",
    inputTokens: 1000,
    outputTokens: 200,
    cachedTokens: 0,
    estimatedCostUsd: 0.005,
    ...o,
  };
}

/** ローカル YYYY-MM-DD */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function localMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

describe("resolvePeriod", () => {
  it("固定キーワードを解決する", () => {
    expect(resolvePeriod("session")).toEqual({ type: "session" });
    expect(resolvePeriod("window")).toEqual({ type: "window" });
    expect(resolvePeriod("all")).toEqual({ type: "all" });
  });

  it("today / yesterday を日付に解決する", () => {
    const today = localDay(new Date());
    const y = new Date();
    y.setDate(y.getDate() - 1);
    expect(resolvePeriod("today")).toEqual({ type: "day", key: today });
    expect(resolvePeriod("yesterday")).toEqual({ type: "day", key: localDay(y) });
  });

  it("month / lastmonth を月に解決する", () => {
    const cur = localMonth(new Date());
    const lm = new Date();
    lm.setMonth(lm.getMonth() - 1);
    expect(resolvePeriod("month")).toEqual({ type: "month", key: cur });
    expect(resolvePeriod("lastmonth")).toEqual({ type: "month", key: localMonth(lm) });
    expect(resolvePeriod("last-month")).toEqual({ type: "month", key: localMonth(lm) });
  });

  it("任意の YYYY-MM-DD / YYYY-MM を解決する", () => {
    expect(resolvePeriod("2026-05-30")).toEqual({ type: "day", key: "2026-05-30" });
    expect(resolvePeriod("2026-05")).toEqual({ type: "month", key: "2026-05" });
  });

  it("不正トークンは null", () => {
    expect(resolvePeriod("foo")).toBeNull();
    expect(resolvePeriod("2026/05/30")).toBeNull();
    expect(resolvePeriod("2026-5")).toBeNull();
  });
});

describe("aggregate (session path / 非ディスク)", () => {
  const SESSION: PeriodSpec = { type: "session" };

  it("モデル別に集計し cost 降順で並ぶ", () => {
    const records = [
      rec({ model: "gpt-5.4", estimatedCostUsd: 0.01, inputTokens: 100, outputTokens: 10 }),
      rec({ model: "gemini-3-flash", estimatedCostUsd: 0.02, inputTokens: 200, outputTokens: 20 }),
      rec({ model: "gpt-5.4", estimatedCostUsd: 0.03, inputTokens: 300, outputTokens: 30 }),
    ];
    const agg = aggregate(SESSION, "model", records);
    expect(agg.rows.map((r) => r.key)).toEqual(["gpt-5.4", "gemini-3-flash"]);
    expect(agg.rows[0].costUsd).toBeCloseTo(0.04);
    expect(agg.rows[0].inputTokens).toBe(400);
    expect(agg.grand.recordCount).toBe(3);
    expect(agg.grand.costUsd).toBeCloseTo(0.06);
  });

  it("slot 別に集計する", () => {
    const records = [
      rec({ slot: "main", estimatedCostUsd: 0.01 }),
      rec({ slot: "second", estimatedCostUsd: 0.02 }),
      rec({ slot: undefined, estimatedCostUsd: 0.03 }), // 未指定は main 扱い
    ];
    const agg = aggregate(SESSION, "slot", records);
    const main = agg.rows.find((r) => r.key === "main");
    const second = agg.rows.find((r) => r.key === "second");
    expect(main?.recordCount).toBe(2);
    expect(main?.costUsd).toBeCloseTo(0.04);
    expect(second?.recordCount).toBe(1);
  });

  it("provider 別に集計する", () => {
    const records = [rec({ provider: "azure-gpt" }), rec({ provider: "vertex-ai" }), rec({ provider: "azure-gpt" })];
    const agg = aggregate(SESSION, "provider", records);
    expect(agg.rows.find((r) => r.key === "azure-gpt")?.recordCount).toBe(2);
  });

  it("単価未登録モデルを検出する (登録済みは含めない)", () => {
    const records = [
      rec({ model: "gpt-5.4" }), // builtin pricing あり
      rec({ model: "totally-fake-model-xyz" }), // 未登録
    ];
    const agg = aggregate(SESSION, "model", records);
    expect(agg.unpricedModels).toContain("totally-fake-model-xyz");
    expect(agg.unpricedModels).not.toContain("gpt-5.4");
  });

  it("空集合は grand=0", () => {
    const agg = aggregate(SESSION, "model", []);
    expect(agg.grand.recordCount).toBe(0);
    expect(agg.rows).toEqual([]);
  });
});

describe("永続化サイクル (temp dir override)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
    process.env.LOCALLLM_USAGE_DIR = tmp;
  });
  afterEach(() => {
    delete process.env.LOCALLLM_USAGE_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("append → 月/日/全期間で読み戻せる", () => {
    const day = "2026-05-30";
    const otherDay = "2026-05-15";
    appendUsageRecord(rec({ timestamp: `${day}T03:00:00.000Z`, estimatedCostUsd: 0.01 }));
    appendUsageRecord(rec({ timestamp: `${otherDay}T03:00:00.000Z`, estimatedCostUsd: 0.02 }));

    const all = loadRecords({ type: "all" });
    expect(all.length).toBe(2);

    const month = loadRecords({ type: "month", key: "2026-05" });
    expect(month.length).toBe(2);

    // 指定日のみ (timestamp のローカル日付で判定)
    const dayRecs = loadRecords({ type: "day", key: localDay(new Date(`${day}T03:00:00.000Z`)) });
    expect(dayRecs.length).toBe(1);
    expect(dayRecs[0].estimatedCostUsd).toBeCloseTo(0.01);

    // 別月は空
    expect(loadRecords({ type: "month", key: "2026-04" }).length).toBe(0);
  });

  it("append で firstRecordAt / windowStartAt が初期化される", () => {
    appendUsageRecord(rec({ timestamp: "2026-05-30T03:00:00.000Z" }));
    const state = readState();
    expect(state.firstRecordAt).toBe("2026-05-30T03:00:00.000Z");
    expect(state.windowStartAt).toBe("2026-05-30T03:00:00.000Z");
  });

  it("reset で windowStartAt が更新され window フィルタが効く", () => {
    appendUsageRecord(rec({ timestamp: "2026-05-30T03:00:00.000Z", estimatedCostUsd: 0.01 }));
    const cutoff = resetWindow();
    // reset 後に新レコード
    appendUsageRecord(rec({ timestamp: new Date(Date.now() + 1000).toISOString(), estimatedCostUsd: 0.02 }));

    const win = loadRecords({ type: "window" });
    expect(win.length).toBe(1);
    expect(win[0].estimatedCostUsd).toBeCloseTo(0.02);
    expect(readState().windowStartAt).toBe(cutoff);
    // all は両方
    expect(loadRecords({ type: "all" }).length).toBe(2);
  });
});
