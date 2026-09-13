import { describe, expect, it } from "vitest";
import { HierarchicalCompressor } from "../../src/agent/hierarchical-compressor.js";
import type { ChatChunk, LLMProvider } from "../../src/providers/base-provider.js";

describe("HierarchicalCompressor failure policy", () => {
  it("要約失敗時にユーザー文500文字へ置換せず失敗を返す", async () => {
    const provider = {
      async *chat(): AsyncGenerator<ChatChunk> {
        if (process.env.LOCALLLM_TEST_YIELD === "1") yield {} as ChatChunk;
        throw new Error("compressor offline");
      },
    } as unknown as LLMProvider;
    const compressor = new HierarchicalCompressor(provider, "test-model");

    await expect(
      compressor.compress([
        { role: "user", content: "重要な制約".repeat(200) },
        { role: "assistant", content: "実装経緯".repeat(200) },
      ]),
    ).rejects.toThrow(/history was not replaced with a lossy substitute/);
  });

  it("要約応答がJSONでなければ応答全文を要約として採用しない", async () => {
    const provider = {
      async *chat(): AsyncGenerator<ChatChunk> {
        yield { type: "text", text: "だいたい大丈夫です" };
        yield { type: "done", finishReason: "stop" };
      },
    } as unknown as LLMProvider;
    const compressor = new HierarchicalCompressor(provider, "test-model");

    await expect(compressor.compress([{ role: "user", content: "消してはいけない制約" }])).rejects.toThrow(
      /returned no JSON object/,
    );
  });
});

describe("HierarchicalCompressor sequential dispatch", () => {
  it("56ブロックでも同時送信は1件だけ", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const provider = {
      async *chat(): AsyncGenerator<ChatChunk> {
        calls++;
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 0));
          yield { type: "text", text: '{"summary":"preserved","keyFacts":["constraint"]}' };
        } finally {
          active--;
        }
      },
    } as unknown as LLMProvider;
    const c = new HierarchicalCompressor(provider, "test");
    await c.compress(Array.from({ length: 555 }, () => ({ role: "user" as const, content: "retain" })));
    expect(peak).toBe(1);
    expect(calls).toBe(57); // 56 sequential Layer 1 calls, then one Layer 2.
  });

  it("429後は後続ブロックを送らず部分要約も確定しない", async () => {
    let calls = 0;
    const provider = {
      async *chat(): AsyncGenerator<ChatChunk> {
        calls++;
        if (calls === 2) throw new Error("HTTP 429 rate_limit_exceeded");
        yield { type: "text", text: '{"summary":"ok","keyFacts":[]}' };
      },
    } as unknown as LLMProvider;
    const c = new HierarchicalCompressor(provider, "test");
    await expect(
      c.compress(Array.from({ length: 40 }, () => ({ role: "user" as const, content: "retain" }))),
    ).rejects.toThrow("429");
    expect(calls).toBe(2);
    expect(c.getSummaryBlocks()).toEqual([]);
  });

  it("Layer2の429でも以前の要約へ戻して停止する", async () => {
    let calls = 0;
    const provider = {
      async *chat(): AsyncGenerator<ChatChunk> {
        calls++;
        if (calls === 7) throw new Error("rate_limit_exceeded");
        yield { type: "text", text: '{"summary":"ok","keyFacts":[]}' };
      },
    } as unknown as LLMProvider;
    const c = new HierarchicalCompressor(provider, "test");
    await expect(
      c.compress(Array.from({ length: 60 }, () => ({ role: "user" as const, content: "retain" }))),
    ).rejects.toThrow("rate_limit_exceeded");
    expect(c.getSummaryBlocks()).toEqual([]);
  });
});
