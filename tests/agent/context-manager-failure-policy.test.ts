import { describe, expect, it } from "vitest";
import type { ChatChunk, LLMProvider } from "../../src/providers/base-provider.js";
import { ContextManager } from "../../src/agent/context-manager.js";
import { MessageHistory } from "../../src/agent/message-history.js";

function invalidForgetProvider(): LLMProvider {
  const chat = async function* (): AsyncGenerator<ChatChunk> {
    yield { type: "text", text: "忘れるものはありません" } as ChatChunk;
    yield { type: "done", finishReason: "stop" } as ChatChunk;
  };
  return { chat } as unknown as LLMProvider;
}

describe("ContextManager failure policy", () => {
  it("forget の適用不能を compress に自動置換せず履歴を保持する", async () => {
    const history = new MessageHistory("system");
    history.addUserMessage("重要な制約を保持して");
    history.addAssistantMessage("保持します");
    const before = history.getRawMessages();
    const manager = new ContextManager(invalidForgetProvider(), "m", 1_000, 0.7, 10, "forget");

    await expect(manager.reduce(history)).rejects.toThrow("contextReduction=forget を適用できませんでした");
    expect(history.getRawMessages()).toEqual(before);
  });
});
