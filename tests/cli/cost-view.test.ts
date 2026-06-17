import { describe, it, expect } from "vitest";
import type { TokenUsageRecord } from "../../src/cost/token-tracker.js";
import { formatSummary, formatModels, formatProviders } from "../../src/cli/cost-view.js";
import type { PeriodSpec } from "../../src/cost/usage-store.js";

const SESSION: PeriodSpec = { type: "session" };

function rec(o: Partial<TokenUsageRecord>): TokenUsageRecord {
  return {
    timestamp: new Date().toISOString(),
    provider: "azure-gpt",
    model: "gpt-5.4",
    slot: "main",
    inputTokens: 1000,
    outputTokens: 200,
    cachedTokens: 0,
    estimatedCostUsd: 0.01,
    ...o,
  };
}

// chalk は非 TTY (テスト) では色を付けないため、 出力はプレーン文字列として検証できる。
const text = (lines: string[]) => lines.join("\n");

describe("cost-view formatSummary", () => {
  it("記録ゼロなら『記録はありません』", () => {
    const out = text(formatSummary(SESSION, []));
    expect(out).toContain("記録はありません");
  });

  it("grand 合計と上位モデルを出す", () => {
    const out = text(
      formatSummary(SESSION, [
        rec({ model: "gpt-5.4", estimatedCostUsd: 0.09, inputTokens: 1000, outputTokens: 100 }),
        rec({ model: "gemini-3-flash", estimatedCostUsd: 0.01, inputTokens: 500, outputTokens: 50 }),
      ]),
    );
    expect(out).toContain("Requests: 2");
    expect(out).toContain("gpt-5.4");
    expect(out).toContain("$0.1000"); // grand cost
    expect(out).toContain("(90%)"); // gpt-5.4 のコスト比
  });

  it("jpyPerUsd 指定時はドルを出さず円のみ表示する", () => {
    const records = [
      rec({ model: "gpt-5.4", estimatedCostUsd: 0.09, inputTokens: 1000, outputTokens: 100 }),
      rec({ model: "gemini-3-flash", estimatedCostUsd: 0.01, inputTokens: 500, outputTokens: 50 }),
    ];
    const out = text(formatSummary(SESSION, records, 150));
    expect(out).toContain("¥15"); // grand 0.10 USD * 150 = ¥15
    expect(out).not.toContain("$0.1000"); // ドルは併記しない
  });
});

describe("cost-view formatModels", () => {
  it("モデル別の単価と算出根拠、 未登録警告を出す", () => {
    const out = text(
      formatModels(SESSION, [
        rec({ model: "gpt-5.4" }),
        rec({ model: "totally-fake-model-xyz", estimatedCostUsd: 0 }),
      ]),
    );
    expect(out).toContain("単価(in/out $/M)");
    expect(out).toContain("2.50 / 15.00"); // gpt-5.4 builtin pricing
    expect(out).toContain("未登録");
    expect(out).toContain("単価未登録: totally-fake-model-xyz");
    expect(out).toContain("算出: cost =");
    expect(out).toContain("合計");
  });

  it("jpyPerUsd 指定時は cost 列ヘッダが cost(¥) になり円表示する", () => {
    const out = text(
      formatModels(SESSION, [rec({ model: "gpt-5.4", estimatedCostUsd: 0.02 })], 150),
    );
    expect(out).toContain("cost(¥)");
    expect(out).toContain("¥3"); // 0.02 USD * 150 = ¥3
    expect(out).toContain("2.50 / 15.00"); // 単価列は USD 据え置き
  });
});

describe("cost-view formatProviders", () => {
  it("provider 別と slot 別の 2 テーブルを出す", () => {
    const out = text(
      formatProviders(SESSION, [
        rec({ provider: "azure-gpt", slot: "main" }),
        rec({ provider: "vertex-ai", slot: "second" }),
      ]),
    );
    expect(out).toContain("provider 別");
    expect(out).toContain("slot 別");
    expect(out).toContain("azure-gpt");
    expect(out).toContain("vertex-ai");
    expect(out).toContain("main");
    expect(out).toContain("second");
  });
});
