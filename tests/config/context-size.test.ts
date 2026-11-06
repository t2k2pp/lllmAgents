import { describe, expect, it } from "vitest";
import { formatContextSize, parseContextSize } from "../../src/config/context-size.js";

describe("parseContextSize", () => {
  it.each([
    ["131072", 131072],
    ["131,072", 131072],
    [" 131072 ", 131072],
    ["131K", 131000],
    ["131k", 131000],
    ["128 k", 128000],
    ["1M", 1000000],
    ["1.5m", 1500000],
    ["32.768K", 32768],
  ])("%s → %d", (text, tokens) => {
    expect(parseContextSize(text)).toBe(tokens);
  });

  it.each(["", "abc", "0", "0K", "-4096", "131KB", "1G", "1.5", "K", "131K131"])("%s は解釈しない (null)", (text) => {
    expect(parseContextSize(text)).toBeNull();
  });

  it("一覧の表示は切り捨て", () => {
    expect(formatContextSize(131072)).toBe("131K");
    expect(formatContextSize(32768)).toBe("32K");
    expect(formatContextSize(1999999)).toBe("1.9M");
    expect(formatContextSize(512)).toBe("512");
  });

  it("一覧の表示 (formatContextSize) をそのまま打ち込むと、 モデルの上限を超えない", () => {
    for (const max of [4096, 8192, 32768, 40960, 131072, 262144, 1048576, 1999999]) {
      const typed = parseContextSize(formatContextSize(max));
      expect(typed).not.toBeNull();
      expect(typed as number).toBeLessThanOrEqual(max);
    }
  });
});

describe("parseTokenCount (/model context と同じ解釈)", () => {
  it("parseContextSize と同じ値・解釈できない時は NaN", async () => {
    const { parseTokenCount } = await import("../../src/config/types.js");
    expect(parseTokenCount("131K")).toBe(131000);
    expect(parseTokenCount("131,072")).toBe(131072);
    expect(parseTokenCount("200k")).toBe(200000);
    expect(parseTokenCount("0")).toBeNaN();
    expect(parseTokenCount("abc")).toBeNaN();
  });
});
