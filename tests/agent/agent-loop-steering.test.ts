import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import type { SecurityConfig } from "../../src/config/types.js";
import { ToolRegistry, type ToolHandler } from "../../src/tools/tool-registry.js";

function securityConfig(autoApproveTools: string[] = []): SecurityConfig {
  return {
    allowedDirectories: [],
    blockedCommands: [],
    autoApproveTools,
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
  };
}

function scriptedProvider(
  replies: ChatChunk[][],
  requests: ChatWithToolsParams[],
  beforeDone?: (call: number) => void,
): LLMProvider {
  let call = 0;
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    requests.push({ ...params, messages: params.messages.map((message) => ({ ...message })) });
    const current = call++;
    for (const chunk of replies[Math.min(current, replies.length - 1)] ?? []) {
      if (chunk.type === "done") beforeDone?.(current);
      yield chunk;
    }
  };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: chatWithTools,
    chatWithTools,
    supportsVision: async () => false,
    chatWithVision: chatWithTools,
  } as unknown as LLMProvider;
}

function textReply(text: string): ChatChunk[] {
  return [
    { type: "text", text },
    { type: "done", finishReason: "stop" },
  ];
}

function makeLoop(provider: LLMProvider, registry = new ToolRegistry()): AgentLoop {
  return new AgentLoop(
    provider,
    "test-model-7b",
    registry,
    new PermissionManager(securityConfig(registry.getToolNames())),
    128_000,
    0.8,
  );
}

describe("AgentLoop foreground steering", () => {
  it("LLM応答中の追加入力を別turnにせず、reply境界で同じrunへ注入する", async () => {
    const requests: ChatWithToolsParams[] = [];
    const ref: { loop?: AgentLoop } = {};
    const provider = scriptedProvider(
      [textReply("最初の回答。"), textReply("失敗テストの修正が完了しました。")],
      requests,
      (call) => {
        if (call === 0) expect(ref.loop?.queueSteering("失敗テストを修正して").status).toBe("queued");
      },
    );
    const loop = makeLoop(provider);
    ref.loop = loop;

    await loop.run("好きな色は何ですか？");

    expect(requests).toHaveLength(2);
    expect(
      requests[1].messages.some((message) => message.role === "user" && message.content === "失敗テストを修正して"),
    ).toBe(true);
    expect(loop.getPendingSteeringCount()).toBe(0);
  });

  it("tool実行中の追加入力をtool resultの後、次のLLM要求へFIFO注入する", async () => {
    const requests: ChatWithToolsParams[] = [];
    const ref: { loop?: AgentLoop } = {};
    const registry = new ToolRegistry();
    const probe: ToolHandler = {
      name: "steering_probe",
      definition: {
        type: "function",
        function: { name: "steering_probe", description: "test probe", parameters: { type: "object", properties: {} } },
      },
      execute: async () => {
        expect(ref.loop?.queueSteering("実装より原因調査を優先して").status).toBe("queued");
        return { success: true, output: "probe completed" };
      },
    };
    registry.register(probe);
    const provider = scriptedProvider(
      [
        [
          {
            type: "tool_call",
            toolCall: { id: "call_probe", type: "function", function: { name: "steering_probe", arguments: "{}" } },
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        textReply("原因調査を優先しました。"),
      ],
      requests,
    );
    const loop = makeLoop(provider, registry);
    ref.loop = loop;

    await loop.run("状況を教えてください？");

    expect(requests).toHaveLength(2);
    const messages = requests[1].messages;
    const toolIndex = messages.findIndex((message) => message.role === "tool" && message.content === "probe completed");
    const steerIndex = messages.findIndex(
      (message) => message.role === "user" && message.content === "実装より原因調査を優先して",
    );
    expect(toolIndex).toBeGreaterThan(-1);
    expect(steerIndex).toBeGreaterThan(toolIndex);
  });

  it("非実行中・空文字・長過ぎる入力・満杯を明示的に拒否する", () => {
    const loop = makeLoop(scriptedProvider([], []));
    expect(loop.queueSteering("later").status).toBe("not_running");

    loop.isProcessing = true;
    expect(loop.queueSteering("   ").status).toBe("invalid_message");
    expect(loop.queueSteering("x".repeat(4001)).status).toBe("message_too_long");
    for (let i = 0; i < 20; i++) expect(loop.queueSteering(`follow-up-${i}`).status).toBe("queued");
    expect(loop.queueSteering("overflow").status).toBe("queue_full");
    expect(loop.getPendingSteeringCount()).toBe(20);
    expect(loop.takePendingSteering()).toHaveLength(20);
    expect(loop.getPendingSteeringCount()).toBe(0);
  });

  it("REPLがRoom順番待ちの間に動くDiscord/Slack runへ誤注入しない", () => {
    const loop = makeLoop(scriptedProvider([], []));
    loop.isProcessing = true;
    (loop as unknown as { currentSource: "discord" | "slack" }).currentSource = "discord";

    expect(loop.queueSteering("REPL Room向けの追加入力")).toEqual({ status: "not_running", pending: 0 });
    expect(loop.getPendingSteeringCount()).toBe(0);
  });
});
