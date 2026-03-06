import { describe, it, expect } from "vitest";
import { BUILTIN_PRICING, getModelPricing } from "../../src/cost/pricing-table.js";

describe("PricingTable", () => {
  describe("BUILTIN_PRICING", () => {
    it("主要モデルのエントリが存在する", () => {
      expect(BUILTIN_PRICING["gemini-3-flash"]).toBeDefined();
      expect(BUILTIN_PRICING["gpt-5.2"]).toBeDefined();
      expect(BUILTIN_PRICING["claude-sonnet-4.6"]).toBeDefined();
    });

    it("各モデルに inputPerMToken と outputPerMToken がある", () => {
      for (const [, pricing] of Object.entries(BUILTIN_PRICING)) {
        expect(pricing.inputPerMToken).toBeGreaterThan(0);
        expect(pricing.outputPerMToken).toBeGreaterThan(0);
      }
    });
  });

  describe("getModelPricing", () => {
    it("完全一致で料金を取得できる", () => {
      const pricing = getModelPricing("gemini-3-flash");
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(0.50);
    });

    it("プレフィックス一致で料金を取得できる", () => {
      const pricing = getModelPricing("gemini-3-flash-001");
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(0.50);
    });

    it("存在しないモデルは null を返す", () => {
      const pricing = getModelPricing("nonexistent-model-xyz");
      expect(pricing).toBeNull();
    });
  });
});
