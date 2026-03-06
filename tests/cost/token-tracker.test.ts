import { describe, it, expect } from "vitest";
import { TokenTracker } from "../../src/cost/token-tracker.js";
import type { TokenUsageRecord } from "../../src/cost/token-tracker.js";

describe("TokenTracker", () => {
  function createRecord(overrides?: Partial<TokenUsageRecord>): TokenUsageRecord {
    return {
      timestamp: new Date().toISOString(),
      provider: "vertex-ai",
      model: "gemini-3-flash",
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 0,
      estimatedCostUsd: 0.002,
      ...overrides,
    };
  }

  describe("record / getSessionTotal", () => {
    it("記録した使用量が集計される", () => {
      const tracker = new TokenTracker();
      tracker.record(createRecord({ inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.005 }));
      tracker.record(createRecord({ inputTokens: 2000, outputTokens: 1000, estimatedCostUsd: 0.010 }));

      const total = tracker.getSessionTotal();
      expect(total.totalInputTokens).toBe(3000);
      expect(total.totalOutputTokens).toBe(1500);
      expect(total.totalCostUsd).toBeCloseTo(0.015);
      expect(total.recordCount).toBe(2);
    });

    it("空の場合はゼロが返される", () => {
      const tracker = new TokenTracker();
      const total = tracker.getSessionTotal();
      expect(total.totalInputTokens).toBe(0);
      expect(total.totalOutputTokens).toBe(0);
      expect(total.totalCostUsd).toBe(0);
      expect(total.recordCount).toBe(0);
    });
  });

  describe("getRecords", () => {
    it("記録した全レコードを取得できる", () => {
      const tracker = new TokenTracker();
      tracker.record(createRecord());
      tracker.record(createRecord());

      const records = tracker.getRecords();
      expect(records.length).toBe(2);
    });
  });
});
