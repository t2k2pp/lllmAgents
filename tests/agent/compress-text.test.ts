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

/** 思考モデルで圧縮結果が上限で切れる件 (docs/context-reduction-reasoning-model-fix.md §5) */
describe("compressText — 出力上限での打ち切りと思考オフ", () => {
  it("finishReason=length の圧縮結果は原文より短くても採用しない", async () => {
    const truncated = {
      async *chat(): AsyncGenerator<ChatChunk> {
        yield { type: "text", text: "途中までの要約" };
        yield { type: "done", finishReason: "length" };
      },
    } as unknown as LLMProvider;
    await expect(compressText(truncated, "m", "メモ", LONG)).rejects.toThrow("finishReason=length");
  });

  it("disableThinking=true で呼ぶ", async () => {
    const calls: Array<{ disableThinking?: boolean }> = [];
    const provider = {
      async *chat(params: { disableThinking?: boolean }): AsyncGenerator<ChatChunk> {
        calls.push(params);
        yield { type: "text", text: "短い要約" };
        yield { type: "done", finishReason: "stop" };
      },
    } as unknown as LLMProvider;
    await compressText(provider, "m", "メモ", LONG);
    expect(calls[0].disableThinking).toBe(true);
  });
});
