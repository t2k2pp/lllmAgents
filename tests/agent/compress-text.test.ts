import { describe, it, expect } from "vitest";
import { compressText } from "../../src/agent/compress-text.js";
import type { LLMProvider, ChatChunk } from "../../src/providers/base-provider.js";

/** chat() が指定テキストを 1 チャンクで返す mock provider */
function mockProvider(reply: string | (() => never)): LLMProvider {
  return {
    async *chat(): AsyncGenerator<ChatChunk> {
      if (typeof reply === "function") reply(); // throw
      yield { type: "text", text: reply as string };
      yield { type: "done", finishReason: "stop" };
    },
  } as unknown as LLMProvider;
}

const LONG = "これはとても冗長で重複の多い長い長い原文です。".repeat(20);

describe("compressText — サイズガードと原文保持", () => {
  it("圧縮版が小さければ applied=true で圧縮版を使う", async () => {
    const r = await compressText(mockProvider("短い要約"), "m", "メモ", LONG);
    expect(r.applied).toBe(true);
    expect(r.text).toBe("短い要約");
    expect(r.original).toBe(LONG); // 原文は常に保持
    expect(r.afterTokens).toBeLessThan(r.beforeTokens);
  });

  it("圧縮後が原文以上なら applied=false で原文を使う (サイズガード)", async () => {
    // 原文より長い応答を返させる
    const r = await compressText(mockProvider(LONG + LONG), "m", "メモ", LONG);
    expect(r.applied).toBe(false);
    expect(r.text).toBe(LONG); // サイズガードは原文を保持する
    expect(r.note).toContain("原文を使用");
  });

  it("空応答を原文使用の成功に置換しない", async () => {
    await expect(compressText(mockProvider("   "), "m", "メモ", LONG)).rejects.toThrow("空応答");
  });

  it("provider 例外を原文使用の成功に置換しない", async () => {
    const throwing = mockProvider(() => {
      throw new Error("boom");
    });
    await expect(compressText(throwing, "m", "プロジェクト指示", LONG)).rejects.toThrow("boom");
  });
});
