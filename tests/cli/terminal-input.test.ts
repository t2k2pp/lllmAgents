import { describe, expect, it } from "vitest";
import { MouseKeypressFilter, TerminalScrollInputParser } from "../../src/cli/terminal-input.js";

describe("TerminalScrollInputParser", () => {
  it("Page keyとSGR wheelを区別し、releaseと通常mouse buttonを無視する", () => {
    const parser = new TerminalScrollInputParser();

    expect(parser.feed("\x1b[5;2~\x1b[6~")).toEqual([
      { direction: "up", source: "page" },
      { direction: "down", source: "page" },
    ]);
    expect(parser.feed("\x1b[<68;10;4M\x1b[<69;10;4M")).toEqual([
      { direction: "up", source: "wheel" },
      { direction: "down", source: "wheel" },
    ]);
    expect(parser.feed("\x1b[<64;10;4m\x1b[<0;10;4M")).toEqual([]);
  });

  it("legacy X10 wheelをbyteのまま復元する", () => {
    const parser = new TerminalScrollInputParser();

    expect(parser.feed(Buffer.from([0x1b, 0x5b, 0x4d, 96, 42, 36]))).toEqual([{ direction: "up", source: "wheel" }]);
    expect(parser.feed(Buffer.from([0x1b, 0x5b, 0x4d, 97, 42, 36]))).toEqual([{ direction: "down", source: "wheel" }]);
  });
});

describe("MouseKeypressFilter", () => {
  it("readlineが分割したSGRマウスreport全体を入力文字から除外する", () => {
    const filter = new MouseKeypressFilter();

    expect(filter.shouldIgnore("\x1b[<")).toBe(true);
    for (const fragment of ["6", "4", ";", "1", "0", ";", "4", "M"]) {
      expect(filter.shouldIgnore(fragment)).toBe(true);
    }
    expect(filter.shouldIgnore("a")).toBe(false);
  });

  it("1 keypressで届くSGRマウスreportだけを除外する", () => {
    const filter = new MouseKeypressFilter();

    expect(filter.shouldIgnore("\x1b[<65;10;4M")).toBe(true);
    expect(filter.shouldIgnore("M")).toBe(false);
  });

  it("legacy X10 reportの後続3 byteを入力文字から除外する", () => {
    const filter = new MouseKeypressFilter();

    expect(filter.shouldIgnore("\x1b[M")).toBe(true);
    expect(filter.shouldIgnore("`")).toBe(true);
    expect(filter.shouldIgnore("*")).toBe(true);
    expect(filter.shouldIgnore("$")).toBe(true);
    expect(filter.shouldIgnore("b")).toBe(false);
  });
});
