import { describe, it, expect } from "vitest";
import { classifyChunkNewline } from "../../src/cli/interactive-input.js";

/**
 * 2026-06-13: IME 確定 + Enter が ConPTY で 1 チャンクに合流すると
 * 旧判定 (複数バイト + 改行 = 貼り付け) が誤発動し、 Enter が確定でなく
 * 改行挿入になって「一度無駄に Enter を押さないと送信できない」 症状が出た。
 * 改行の位置 (本文中 / 末尾のみ) で貼り付けと行確定を区別する。
 */
describe("classifyChunkNewline — 貼り付けと行確定の区別", () => {
  it("改行を含まないチャンクは none (通常タイプ・IME確定テキスト)", () => {
    expect(classifyChunkNewline(Buffer.from("a"))).toBe("none");
    expect(classifyChunkNewline(Buffer.from("続けて", "utf8"))).toBe("none");
    expect(classifyChunkNewline(Buffer.alloc(0))).toBe("none");
  });

  it("「テキスト + 末尾改行」 の合流チャンクは line-submit (IME確定+Enter / cooked行フラッシュ)", () => {
    expect(classifyChunkNewline(Buffer.from("続けて\r", "utf8"))).toBe("line-submit");
    expect(classifyChunkNewline(Buffer.from("続けて\r\n", "utf8"))).toBe("line-submit");
    expect(classifyChunkNewline(Buffer.from("hello\n"))).toBe("line-submit");
  });

  it("改行のみのチャンクは line-submit (単発 Enter キー)", () => {
    expect(classifyChunkNewline(Buffer.from("\r"))).toBe("line-submit");
    expect(classifyChunkNewline(Buffer.from("\r\n"))).toBe("line-submit");
  });

  it("本文の途中に改行があるチャンクは paste-burst (マルチライン貼り付け)", () => {
    expect(classifyChunkNewline(Buffer.from("line1\rline2"))).toBe("paste-burst");
    expect(classifyChunkNewline(Buffer.from("line1\r\nline2\r\n"))).toBe("paste-burst");
    expect(classifyChunkNewline(Buffer.from("あ\rい\r", "utf8"))).toBe("paste-burst");
  });
});
