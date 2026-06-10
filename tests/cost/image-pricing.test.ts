import { describe, it, expect } from "vitest";
import { getImageUnitPrice, BUILTIN_IMAGE_PRICING } from "../../src/cost/image-pricing.js";

describe("image-pricing", () => {
  describe("getImageUnitPrice", () => {
    it("登録済みモデルの 1024x1024 基準単価を返す", () => {
      const price = getImageUnitPrice("gpt-image-2", "medium", 1024, 1024);
      expect(price).toBeCloseTo(BUILTIN_IMAGE_PRICING["gpt-image-2"].medium);
    });

    it("品質別の単価を区別する", () => {
      const low = getImageUnitPrice("gpt-image-2", "low", 1024, 1024);
      const high = getImageUnitPrice("gpt-image-2", "high", 1024, 1024);
      expect(low).not.toBeNull();
      expect(high).not.toBeNull();
      expect(high as number).toBeGreaterThan(low as number);
    });

    it("サイズはピクセル数比でスケールする (1536x1024 = 1.5倍)", () => {
      const base = getImageUnitPrice("gpt-image-2", "medium", 1024, 1024) as number;
      const wide = getImageUnitPrice("gpt-image-2", "medium", 1536, 1024) as number;
      expect(wide).toBeCloseTo(base * 1.5);
    });

    it("スナップショット版モデル名は prefix 一致で解決 (gpt-image-2-2026-04-21)", () => {
      const price = getImageUnitPrice("gpt-image-2-2026-04-21", "medium", 1024, 1024);
      expect(price).toBeCloseTo(BUILTIN_IMAGE_PRICING["gpt-image-2"].medium);
    });

    it("未登録モデルは null (cost=0 + 警告表示の顕在化方針)", () => {
      expect(getImageUnitPrice("unknown-image-model", "medium", 1024, 1024)).toBeNull();
    });
  });
});
