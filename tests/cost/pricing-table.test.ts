import { describe, it, expect } from "vitest";
import { BUILTIN_PRICING, getModelPricing } from "../../src/cost/pricing-table.js";

describe("PricingTable", () => {
  describe("BUILTIN_PRICING", () => {
    it("主要モデルのエントリが存在する", () => {
      expect(BUILTIN_PRICING["gemini-3-flash"]).toBeDefined();
      expect(BUILTIN_PRICING["gpt-5.2"]).toBeDefined();
      // Claude キーは実モデルID(ハイフン表記)に統一済 (docs/prompt-cache-cost-reduction.md)
      expect(BUILTIN_PRICING["claude-sonnet-4-6"]).toBeDefined();
      expect(BUILTIN_PRICING["claude-opus-4-8"]).toBeDefined();
    });

    it("Claude モデルにプロンプトキャッシュ単価(0.1×)がある", () => {
      const sonnet = BUILTIN_PRICING["claude-sonnet-4-6"];
      expect(sonnet.cachedInputPerMToken).toBeCloseTo(sonnet.inputPerMToken * 0.1, 5);
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

    it("ハイフン表記の実Claude IDで料金が取れる(旧ドット表記の取りこぼし回帰防止)", () => {
      // 旧版はキーが "claude-sonnet-4.6"(ドット)で実ID "claude-sonnet-4-6"(ハイフン)と
      // 前方一致せず null=コスト0 になっていた。 統一後はマッチすること。
      const pricing = getModelPricing("claude-sonnet-4-6");
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(3.00);
      expect(pricing!.outputPerMToken).toBe(15.00);
    });
  });
});
