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
