import { describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import type { ChatChunk, LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import type { SecurityConfig } from "../../src/config/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

function scriptedProvider(replies: ChatChunk[][]): LLMProvider {
  let call = 0;
  const chat = async function* (): AsyncGenerator<ChatChunk> {
    for (const chunk of replies[Math.min(call++, replies.length - 1)] ?? []) yield chunk;
  };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat,
    chatWithTools: chat,
    supportsVision: async () => false,
    chatWithVision: chat,
  } as unknown as LLMProvider;
}

describe("AgentLoop buffered response display", () => {
  it.each([
    {
      name: "finish_reason=length",
      firstText: "前半の本文です。",
      finishReason: "length" as const,
      expected: "前半の本文です。",
    },
    {
      name: "構造的不完全",
      firstText: "```ts\nconst visibleBeforeContinuation = true;",
      finishReason: "stop" as const,
      expected: "const visibleBeforeContinuation = true;",
    },
  ])("$name の継続前本文を1行プレビューだけで表示済みにせず確定出力する", async ({
    firstText,
    finishReason,
    expected,
  }) => {
    const registry = new ToolRegistry();
    registry.register({
      name: "response_complete",
      definition: {
        type: "function",
        function: {
          name: "response_complete",
          description: "test completion",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => ({ success: true, output: "completed" }),
    });
    const security: SecurityConfig = {
      allowedDirectories: [],
      blockedCommands: [],
      autoApproveTools: ["response_complete"],
      requireApprovalTools: [],
      discordAutoApproveTools: [],
      slackAutoApproveTools: [],
      rules: { allow: [], deny: [], ask: [] },
    };
    const provider = scriptedProvider([
      [
        { type: "text", text: firstText },
        { type: "done", finishReason },
      ],
      [
        { type: "text", text: "後半の本文です。" },
        {
          type: "tool_call",
          toolCall: {
            id: "complete-1",
            type: "function",
            function: { name: "response_complete", arguments: '{"summary":"完了","force":true}' },
          },
        },
        { type: "done", finishReason: "tool_calls" },
      ],
    ]);
    const loop = new AgentLoop(provider, "test-model-7b", registry, new PermissionManager(security), 128_000, 0.8);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => output.push(args.join(" ")));

    try {
      await loop.run("最後まで回答して");
    } finally {
      log.mockRestore();
    }

    const displayed = output.join("\n");
    expect(displayed).toContain(expected);
    expect(displayed).toContain("後半の本文です。");
  });
});
