import { describe, it, expect } from "vitest";
import { CostCalculator } from "../../src/cost/cost-calculator.js";
import type { ModelPricing } from "../../src/cost/pricing-table.js";

describe("CostCalculator", () => {
  const calc = new CostCalculator();

  const samplePricing: ModelPricing = {
    inputPerMToken: 1.00,   // $1 per 1M input tokens
    outputPerMToken: 5.00,  // $5 per 1M output tokens
  };

  describe("calculate", () => {
    it("入力・出力トークンに基づきコストを算出", () => {
      const cost = calc.calculate(1_000_000, 1_000_000, samplePricing);
      expect(cost).toBeCloseTo(6.0); // $1 + $5
    });

    it("少量トークンのコスト算出", () => {
      const cost = calc.calculate(1000, 500, samplePricing);
      // 1000 * 1.00 / 1M + 500 * 5.00 / 1M = 0.001 + 0.0025 = 0.0035
      expect(cost).toBeCloseTo(0.0035);
    });

    it("0トークンの場合は0", () => {
      const cost = calc.calculate(0, 0, samplePricing);
      expect(cost).toBe(0);
    });
  });

  describe("calculateWithCache", () => {
    const pricingWithCache: ModelPricing = {
      inputPerMToken: 2.00,
      outputPerMToken: 10.00,
      cachedInputPerMToken: 0.50,
    };

    it("キャッシュヒット分は低い単価で計算", () => {
      const cost = calc.calculateWithCache(1_000_000, 500_000, 300_000, pricingWithCache);
      // uncached: 700K * 2.00 / 1M = 1.4
      // cached: 300K * 0.50 / 1M = 0.15
      // output: 500K * 10.00 / 1M = 5.0
      // total = 6.55
      expect(cost).toBeCloseTo(6.55);
    });

    it("cachedInputPerMToken 未設定の場合は通常単価で計算", () => {
      const cost = calc.calculateWithCache(1_000_000, 500_000, 300_000, samplePricing);
      // cachedInputPerMToken が undefined → inputPerMToken を使用
      // uncached: 700K * 1.00 / 1M = 0.7
      // cached: 300K * 1.00 / 1M = 0.3
      // output: 500K * 5.00 / 1M = 2.5
      // total = 3.5
      expect(cost).toBeCloseTo(3.5);
    });
  });

  describe("calculateForModelWithCache", () => {
    it("gpt-5.4 のキャッシュ単価 (入力 0.1×) を適用する", () => {
      // 全量キャッシュヒット: 1M × $0.25/M = $0.25 (通常入力 $2.50 の 0.1×)
      expect(calc.calculateForModelWithCache("gpt-5.4", 1_000_000, 0, 1_000_000)).toBeCloseTo(0.25);
      // キャッシュなし: 1M × $2.50/M = $2.50
      expect(calc.calculateForModelWithCache("gpt-5.4", 1_000_000, 0, 0)).toBeCloseTo(2.5);
    });

    it("キャッシュ加味で大幅に安くなる (250万入力の実例)", () => {
      const inTok = 2_557_113, outTok = 10_842;
      const noCache = calc.calculateForModelWithCache("gpt-5.4", inTok, outTok, 0);
      const cached80 = calc.calculateForModelWithCache("gpt-5.4", inTok, outTok, Math.round(inTok * 0.8));
      expect(noCache).toBeCloseTo(6.55, 1); // 表示されていた値
      expect(cached80).toBeLessThan(noCache * 0.45); // 8 割キャッシュで半分以下
    });

    it("未登録モデルは 0", () => {
      expect(calc.calculateForModelWithCache("totally-fake-xyz", 1000, 1000, 500)).toBe(0);
    });
  });

  describe("calculateReferencesCosts", () => {
    it("参考モデルのコストを算出", () => {
      const refs = calc.calculateReferencesCosts(10_000, 5_000, ["gemini-3-flash", "gpt-5.2"]);
      expect(refs.length).toBeGreaterThanOrEqual(1);
      for (const ref of refs) {
        expect(ref.model).toBeDefined();
        expect(ref.estimatedCostUsd).toBeGreaterThanOrEqual(0);
      }
    });

    it("存在しないモデルはスキップされる", () => {
      const refs = calc.calculateReferencesCosts(10_000, 5_000, ["nonexistent-model-xyz"]);
      expect(refs.length).toBe(0);
    });
  });
});
