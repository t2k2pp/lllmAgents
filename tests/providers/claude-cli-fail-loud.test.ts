import { describe, it, expect } from "vitest";
import { ClaudeCliProvider } from "../../src/providers/claude-cli.js";
import type { ChatChunk, ToolDefinition } from "../../src/providers/base-provider.js";

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const dummyTool: ToolDefinition = {
  type: "function",
  function: {
    name: "file_read",
    description: "ファイル読取",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

describe("ClaudeCliProvider — Fail loud on tool calling", () => {
  it("tools が渡されたら subprocess を起動せず error chunk を返す", async () => {
    const provider = new ClaudeCliProvider({ model: "claude-haiku-4-5" });

    const chunks = await collect(
      provider.chatWithTools({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
        tools: [dummyTool],
        stream: true,
      }),
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("error");
    expect(chunks[0].error).toMatch(/claude-cli/);
    expect(chunks[0].error).toMatch(/claude-agent-sdk|anthropic/);
  });

  it("tools が空配列なら通常経路 (doChat) に流す — 起動経路の存在のみ確認", async () => {
    const provider = new ClaudeCliProvider({
      model: "claude-haiku-4-5",
      binPath: "/nonexistent/claude-binary-for-test",
    });

    const chunks = await collect(
      provider.chatWithTools({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        stream: true,
      }),
    );

    // tools 空なので Fail loud にはならず、 doChat 側で spawn 失敗 error が返る。
    // spawn 失敗のメッセージ内容ではなく、 「Fail loud 経路ではなく doChat 経路に入った」
    // ことだけを確認する: error メッセージに claude-agent-sdk への切替案内が含まれない
    expect(chunks.some((c) => c.type === "error")).toBe(true);
    const errChunk = chunks.find((c) => c.type === "error");
    expect(errChunk?.error).not.toMatch(/claude-agent-sdk/);
  });
});
