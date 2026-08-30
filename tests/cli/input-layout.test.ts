import { describe, expect, it } from "vitest";
import { layoutInputBuffer } from "../../src/cli/input-layout.js";
import { getDisplayWidth } from "../../src/utils/display-width.js";

describe("layoutInputBuffer", () => {
  it("端末の最終列を空け、全角入力が右端で自動折返し待ちにならない", () => {
    const columns = 10;
    const layout = layoutInputBuffer("あいうえ", "あいうえ".length, 2, columns);

    expect(layout.screenLines.map((line) => line.text)).toEqual(["あいう", "え"]);
    for (const [index, line] of layout.screenLines.entries()) {
      const prefixWidth = 2;
      expect(prefixWidth + getDisplayWidth(line.text), `screen line ${index}`).toBeLessThan(columns);
    }
    expect(layout.row).toBe(1);
  });

  it("日本語を一文字ずつ追加入力しても各再描画行は最終列へ到達しない", () => {
    const columns = 12;
    for (const buffer of ["日本語入", "日本語入力", "日本語入力中", "日本語入力中で"]) {
      const layout = layoutInputBuffer(buffer, buffer.length, 2, columns);
      for (const line of layout.screenLines) {
        expect(2 + getDisplayWidth(line.text), buffer).toBeLessThan(columns);
      }
    }
  });

  it("結合文字とZWJ絵文字を分割せずに物理行へ配置する", () => {
    const buffer = "e\u0301👩‍💻あ";
    const layout = layoutInputBuffer(buffer, buffer.length, 2, 7);

    expect(layout.screenLines.map((line) => line.text)).toEqual(["e\u0301👩‍💻", "あ"]);
    expect(getDisplayWidth("e\u0301")).toBe(1);
    expect(getDisplayWidth("👩‍💻")).toBe(2);
  });
});
