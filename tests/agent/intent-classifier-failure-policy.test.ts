import { describe, expect, it } from "vitest";
import type { ChatChunk, LLMProvider } from "../../src/providers/base-provider.js";
import { IntentClassifier } from "../../src/agent/intent-classifier.js";

function providerThat(result: string | Error): LLMProvider {
  const chat = async function* (): AsyncGenerator<ChatChunk> {
    if (result instanceof Error) throw result;
    yield { type: "text", text: result } as ChatChunk;
    yield { type: "done", finishReason: "stop" } as ChatChunk;
  };
  return { chat } as unknown as LLMProvider;
}

describe("IntentClassifier failure policy", () => {
  it("曖昧な入力の分類失敗を task に自動置換しない", async () => {
    const classifier = new IntentClassifier(providerThat("unknown"), "m");
    await expect(classifier.classifyIntent("この件について考えてほしい")).rejects.toThrow("Intent 分類に失敗");
  });

  it("完了分類の provider 失敗を other に自動置換しない", async () => {
    const classifier = new IntentClassifier(providerThat(new Error("connection refused")), "m");
    await expect(classifier.classifyCompletion("結果をまとめました")).rejects.toThrow("Completion 分類に失敗");
  });

  it("明白な入力は LLM を呼ばず決定論的に分類する", async () => {
    const classifier = new IntentClassifier(providerThat(new Error("must not be called")), "m");
    await expect(classifier.classifyIntent("こんにちは")).resolves.toBe("conversation");
    await expect(classifier.classifyCompletion("実装が完了しました")).resolves.toBe("completed");
  });
});

/** 思考モデルが 50 tok を思考で使い切る件 (docs/context-reduction-reasoning-model-fix.md §5) */
describe("IntentClassifier: 思考オフと失敗理由", () => {
  it("LLM 分類は disableThinking=true で呼ぶ", async () => {
    const calls: Array<{ disableThinking?: boolean }> = [];
    const provider = {
      async *chat(params: { disableThinking?: boolean }): AsyncGenerator<ChatChunk> {
        calls.push(params);
        yield { type: "text", text: '{"intent":"question"}' } as ChatChunk;
        yield { type: "done", finishReason: "stop" } as ChatChunk;
      },
    } as unknown as LLMProvider;
    await new IntentClassifier(provider, "m").classifyIntent("この件について考えてほしい");
    expect(calls[0].disableThinking).toBe(true);
  });

  it("本文が空で終わったら finishReason を失敗理由に含める", async () => {
    const provider = {
      async *chat(): AsyncGenerator<ChatChunk> {
        yield { type: "thinking", text: "..." } as ChatChunk;
        yield { type: "done", finishReason: "length" } as ChatChunk;
      },
    } as unknown as LLMProvider;
    await expect(new IntentClassifier(provider, "m").classifyIntent("この件について考えてほしい")).rejects.toThrow(
      "finishReason=length",
    );
  });
});
