import { describe, expect, it } from "vitest";
import { formatBufferedResponseStatus } from "../../src/cli/response-preview.js";
import { getDisplayWidth } from "../../src/utils/display-width.js";

describe("buffered response live preview", () => {
  it("受信済み本文をtoken統計と同じ状態行へ表示する", () => {
    expect(formatBufferedResponseStatus("調査を始めます。", 12, 6, 80)).toBe(
      "  応答中: 調査を始めます。 (12 tok, 6 tok/s)",
    );
  });

  it("改行・ANSI・制御文字を一過性の1行表示へ持ち込まない", () => {
    const status = formatBufferedResponseStatus("\u001b[31m最初の行\u001b[0m\n次の行\u0007", 3, 0, 80);
    expect(status).toContain("最初の行 次の行");
    expect(status).not.toContain("\n");
    expect(status).not.toContain("\u001b");
    expect(status).not.toContain("\u0007");
  });

  it("狭い日本語端末では統計より本文を優先し、表示幅を超えない", () => {
    const status = formatBufferedResponseStatus("日本語の長い応答を生成しています", 120, 42, 20);
    expect(status).toContain("日本語");
    expect(status).not.toContain("tok");
    expect(getDisplayWidth(status)).toBeLessThanOrEqual(20);
  });

  it("本文がまだ空なら従来の受信状態を表示する", () => {
    expect(formatBufferedResponseStatus(" \n\t ", 2, 0, 80)).toBe("  受信中... (2 tok)");
  });
});
