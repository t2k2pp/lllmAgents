import { describe, it, expect } from "vitest";
import { truncateAtLine } from "../../src/agent/system-prompt.js";

describe("truncateAtLine — 欠損を黙って起こさない", () => {
  it("予算内ならそのまま返す (マーカーなし)", () => {
    const text = "短い行1\n短い行2";
    const out = truncateAtLine(text, 1000, "プロジェクト指示");
    expect(out).toBe(text);
    expect(out).not.toContain("⚠");
  });

  it("予算超過時は本文を切るが、必ず可視マーカーで欠損を明示する", () => {
    const text = Array.from({ length: 100 }, (_, i) => `これは${i}行目のテキストです`).join("\n");
    const out = truncateAtLine(text, 200, "メモ");
    // 欠損を隠さない: 何字落としたかと、全文の参照方法を明示
    expect(out).toContain("⚠");
    expect(out).toContain("メモ");
    expect(out).toContain("省略");
    expect(out).toContain("file_read");
    // 省略字数が正の整数で示される
    expect(out).toMatch(/\d+ 字を省略/);
  });

  it("ラベルがマーカーに反映される", () => {
    const text = "x".repeat(5000);
    const out = truncateAtLine(text, 100, "プロジェクト指示");
    expect(out).toContain("プロジェクト指示はトークン予算 100 字を超過");
  });
});
