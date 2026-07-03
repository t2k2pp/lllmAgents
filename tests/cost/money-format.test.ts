import { describe, it, expect, afterEach } from "vitest";
import { formatMoney, setDisplayJpyRate, getDisplayJpyRate } from "../../src/cost/money-format.js";

describe("formatMoney", () => {
  afterEach(() => setDisplayJpyRate(undefined));

  it("レート未設定ならドル表示 ($x.xxxx)", () => {
    expect(formatMoney(0.0123)).toBe("$0.0123");
    expect(formatMoney(0)).toBe("$0.0000");
  });

  it("引数でレート指定時は円表示 (四捨五入)", () => {
    expect(formatMoney(1, 150)).toBe("¥150");
    expect(formatMoney(0.0123, 150)).toBe("¥2"); // 1.845 → 2
  });

  it("モジュール表示レート設定時は省略形でも円表示", () => {
    setDisplayJpyRate(150);
    expect(getDisplayJpyRate()).toBe(150);
    expect(formatMoney(2)).toBe("¥300");
  });

  it("0以下・undefined のレートは未設定扱い", () => {
    setDisplayJpyRate(0);
    expect(getDisplayJpyRate()).toBeUndefined();
    expect(formatMoney(1)).toBe("$1.0000");
    setDisplayJpyRate(-5);
    expect(getDisplayJpyRate()).toBeUndefined();
  });

  it("千区切りを付ける", () => {
    expect(formatMoney(100, 150)).toBe("¥15,000");
  });
});
