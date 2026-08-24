import { describe, expect, it } from "vitest";
import { Utf8ChunkDecoder } from "../../src/utils/utf8-chunk-decoder.js";

describe("Utf8ChunkDecoder", () => {
  it("UTF-8の多バイト文字がチャンク境界を跨いでも文字化けしない", () => {
    const source = "商品品質サイクルを実行する";
    const bytes = Buffer.from(source, "utf8");
    const decoder = new Utf8ChunkDecoder();
    let actual = "";

    for (const byte of bytes) {
      actual += decoder.write(Buffer.from([byte]));
    }
    actual += decoder.end();

    expect(actual).toBe(source);
    expect(actual).not.toContain("\uFFFD");
  });

  it("末尾flushは一度だけ行い、文字列入力も受け付ける", () => {
    const decoder = new Utf8ChunkDecoder();

    expect(decoder.write("完了")).toBe("完了");
    expect(decoder.end()).toBe("");
    expect(decoder.end()).toBe("");
  });
});
