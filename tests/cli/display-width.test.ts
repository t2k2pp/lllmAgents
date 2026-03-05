import { describe, it, expect } from "vitest";
import { getDisplayWidth } from "../../src/cli/interactive-input.js";

describe("getDisplayWidth", () => {
  it("should return 0 for empty string", () => {
    expect(getDisplayWidth("")).toBe(0);
  });

  it("should count ASCII characters as 1 column each", () => {
    expect(getDisplayWidth("hello")).toBe(5);
    expect(getDisplayWidth("> ")).toBe(2);
    expect(getDisplayWidth("abc123")).toBe(6);
  });

  it("should count CJK characters as 2 columns each", () => {
    // 漢字
    expect(getDisplayWidth("日本語")).toBe(6); // 3 chars × 2 columns
    expect(getDisplayWidth("漢字")).toBe(4);   // 2 chars × 2 columns
  });

  it("should count hiragana as 2 columns each", () => {
    expect(getDisplayWidth("あいう")).toBe(6); // 3 chars × 2 columns
    expect(getDisplayWidth("こんにちは")).toBe(10); // 5 chars × 2 columns
  });

  it("should count katakana as 2 columns each", () => {
    expect(getDisplayWidth("カタカナ")).toBe(8); // 4 chars × 2 columns
    expect(getDisplayWidth("テスト")).toBe(6);
  });

  it("should handle mixed ASCII and CJK correctly", () => {
    expect(getDisplayWidth("hello世界")).toBe(9);  // 5 + 2×2
    expect(getDisplayWidth("a日b本c")).toBe(7);    // 3×1 + 2×2
    expect(getDisplayWidth("> こんにちは")).toBe(12); // 2 + 5×2
  });

  it("should count fullwidth ASCII as 2 columns", () => {
    // Ａ = U+FF21 (fullwidth A)
    expect(getDisplayWidth("Ａ")).toBe(2);
    // ！ = U+FF01 (fullwidth exclamation)
    expect(getDisplayWidth("！")).toBe(2);
  });

  it("should count CJK punctuation as 2 columns", () => {
    // 。= U+3002
    expect(getDisplayWidth("。")).toBe(2);
    // 、= U+3001
    expect(getDisplayWidth("、")).toBe(2);
    // 「」= U+300C, U+300D
    expect(getDisplayWidth("「」")).toBe(4);
  });

  it("should handle Korean (Hangul) as 2 columns", () => {
    // 한 = U+D55C
    expect(getDisplayWidth("한글")).toBe(4); // 2 chars × 2 columns
  });

  it("should ignore control characters (width 0)", () => {
    expect(getDisplayWidth("\t")).toBe(0);
    expect(getDisplayWidth("\n")).toBe(0);
    expect(getDisplayWidth("a\tb")).toBe(2); // \t is ignored
  });

  it("should handle realistic input scenarios", () => {
    // Japanese prompt input
    expect(getDisplayWidth("テトリスを作って")).toBe(16); // 8 chars × 2
    // Mixed command
    expect(getDisplayWidth("@src/cli/")).toBe(9); // all ASCII
    // File path with Japanese
    expect(getDisplayWidth("@テスト.ts")).toBe(10); // 1 + 3×2 + 3 = 10
  });
});
