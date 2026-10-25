import { describe, expect, it } from "vitest";
import { LOOP_USAGE_LINES, parseLoopArgs } from "../../src/loop/loop-manager.js";

describe("parseLoopArgs (/loop <間隔> <プロンプト> の 1 形式のみ)", () => {
  it("先頭の間隔とプロンプトを取り出す", () => {
    expect(parseLoopArgs("5m /pr-review")).toEqual({
      ok: true,
      intervalMs: 5 * 60 * 1000,
      intervalStr: "5m",
      prompt: "/pr-review",
    });
  });

  it("プロンプトの空白は 1 つに詰めて保持する", () => {
    const r = parseLoopArgs("30m  デプロイ状況を  確認");
    expect(r.ok && r.prompt).toBe("デプロイ状況を 確認");
  });

  it("間隔の無い入力は既定間隔で登録せず使い方エラー (例: /loop list)", () => {
    const r = parseLoopArgs("list");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("list");
  });

  it("間隔の無い複数語の入力も使い方エラー", () => {
    expect(parseLoopArgs("デプロイ状況を確認").ok).toBe(false);
  });

  it("末尾 every <間隔> の別形式は受け付けない", () => {
    expect(parseLoopArgs("CI を確認 every 20m").ok).toBe(false);
  });

  it("間隔だけでプロンプトが無い入力は使い方エラー (例: /loop 5m)", () => {
    const r = parseLoopArgs("5m");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("プロンプト");
  });

  it("空入力は使い方エラー", () => {
    expect(parseLoopArgs("   ").ok).toBe(false);
  });

  it("使い方には正しい書き方を含める", () => {
    expect(LOOP_USAGE_LINES.join("\n")).toContain("/loop <間隔> <プロンプト>");
  });
});
