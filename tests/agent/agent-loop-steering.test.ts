import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import type { SecurityConfig } from "../../src/config/types.js";
import { ToolRegistry, type ToolHandler } from "../../src/tools/tool-registry.js";
import { saveSession, type SessionData } from "../../src/agent/session-manager.js";

vi.mock("../../src/agent/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/session-manager.js")>();
  return { ...actual, saveSession: vi.fn() };
});

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
  it("durable pauseはtool結果確定後に保存し、別AgentLoopが次APIから一度だけ再開する", async () => {
    vi.mocked(saveSession).mockClear();
    const requests: ChatWithToolsParams[] = [];
    const registry = new ToolRegistry();
    let toolExecutions = 0;
    registry.register({
      name: "durable_probe",
      definition: {
        type: "function",
        function: {
          name: "durable_probe",
          description: "durable test",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => {
        toolExecutions++;
        return { success: true, output: "persisted tool result" };
      },
    });
    const firstRef: { loop?: AgentLoop } = {};
    const firstProvider = scriptedProvider(
      [
        [
          {
            type: "tool_call",
            toolCall: { id: "durable_call", type: "function", function: { name: "durable_probe", arguments: "{}" } },
          },
          { type: "done", finishReason: "tool_calls" },
        ],
      ],
      requests,
      () => expect(firstRef.loop?.requestRunPause("durable").status).toBe("requested"),
    );
    const firstLoop = makeLoop(firstProvider, registry);
    firstRef.loop = firstLoop;
    firstLoop.setLiveBinding({
      providerType: "openai-compat",
      model: "test-model-7b",
      baseUrl: "http://127.0.0.1:8080/v1",
    });

    const firstRun = firstLoop.run("再起動を跨いで続けて");
    await vi.waitFor(() => expect(firstLoop.getRunPauseSnapshot().state).toBe("paused"));
    expect(toolExecutions).toBe(1);
    expect(requests).toHaveLength(1);
    const saved = structuredClone(vi.mocked(saveSession).mock.calls.at(-1)?.[0]) as SessionData;
    expect(saved.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "durable_call",
      content: "persisted tool result",
    });
    expect(firstLoop.getDurableRunCheckpoint().status).toBe("durable_paused");

    // PC停止を模擬: pause中の旧processを終了し、保存済みsessionだけを新AgentLoopへ渡す。
    firstLoop.abort();
    await firstRun;

    const resumedRequests: ChatWithToolsParams[] = [];
    const secondLoop = makeLoop(scriptedProvider([textReply("再起動後に完了しました。")], resumedRequests), registry);
    secondLoop.setLiveBinding({
      providerType: "openai-compat",
      model: "test-model-7b",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
    secondLoop.restoreSession(saved);
    const resumed = secondLoop.beginDurableRunResume();
    expect(resumed.status).toBe("started");
    if (resumed.status === "started") await resumed.continuation;

    expect(toolExecutions).toBe(1);
    expect(resumedRequests).toHaveLength(1);
    expect(
      resumedRequests[0].messages.some((message) => message.role === "tool" && message.tool_call_id === "durable_call"),
    ).toBe(true);
    expect(secondLoop.getDurableRunCheckpoint()).toEqual({ status: "none" });
  });

  it("resume開始済みcheckpointは到達点不明として自動再実行を拒否する", () => {
    const loop = makeLoop(scriptedProvider([], []));
    loop.setLiveBinding({ providerType: "openai-compat", model: "test-model-7b", baseUrl: "http://127.0.0.1:8080/v1" });
    const checkpoint = {
      schemaVersion: 1,
      checkpointId: "checkpoint-1",
      state: "resuming",
      savedAt: "2026-09-03T00:00:00.000Z",
      sessionId: loop.getCurrentSessionId(),
      source: "cli",
      cwdRealpath: fs.realpathSync.native(process.cwd()),
      modelBinding: {
        provider: "openai-compat",
        endpointFingerprint: createHash("sha256")
          .update("openai-compat|test-model-7b|http://127.0.0.1:8080/v1|||||")
          .digest("hex"),
        model: "test-model-7b",
      },
      boundary: "before_llm_request",
      run: {
        userMessageText: "続けて",
        nextIteration: 1,
        emptyResponseRetries: 0,
        codeBlockRetried: false,
        hasExecutedTools: false,
        lastToolSignature: "",
        repeatToolCount: 0,
        pendingVerification: [],
        pendingEvalFiles: [],
        selfCheckRounds: 0,
        progressGateRetries: 0,
        coherenceGateRetries: 0,
      },
    };
    loop.restoreSession({
      meta: {
        id: loop.getCurrentSessionId(),
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        model: "test-model-7b",
        messageCount: 1,
        title: "resume test",
      },
      messages: [{ role: "user", content: "続けて" }],
      runCheckpoint: checkpoint,
    });
    expect(loop.beginDurableRunResume()).toMatchObject({ status: "blocked_unknown_progress" });
  });

  it("進行中APIの完了後にpauseし、resumeまで次のAPI要求を開始しない", async () => {
    const requests: ChatWithToolsParams[] = [];
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const registry = new ToolRegistry();
    let toolExecuted = false;
    registry.register({
      name: "pause_probe",
      definition: {
        type: "function",
        function: { name: "pause_probe", description: "pause test", parameters: { type: "object", properties: {} } },
      },
      execute: async () => {
        toolExecuted = true;
        return { success: true, output: "probe completed" };
      },
    });
    let call = 0;
    const chatWithTools = async function* (request: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
      requests.push(request);
      if (call++ === 0) {
        await firstHold;
        yield {
          type: "tool_call",
          toolCall: { id: "call_pause", type: "function", function: { name: "pause_probe", arguments: "{}" } },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield* textReply("再開後の応答です。");
    };
    const provider = {
      ...scriptedProvider([], []),
      chat: chatWithTools,
      chatWithTools,
      chatWithVision: chatWithTools,
    } as unknown as LLMProvider;
    const loop = makeLoop(provider, registry);

    const running = loop.run("pauseしてください");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(loop.requestRunPause().status).toBe("requested");
    expect(loop.getRunPauseSnapshot().state).toBe("pause_requested");
    releaseFirst();
    await vi.waitFor(() => expect(loop.getRunPauseSnapshot().state).toBe("paused"));
    expect(requests).toHaveLength(1);
    expect(toolExecuted).toBe(false);

    expect(loop.resumeRun().status).toBe("resumed");
    await running;
    expect(toolExecuted).toBe(true);
    expect(requests).toHaveLength(2);
    expect(loop.getRunPauseSnapshot().state).toBe("idle");
  });

  it("pause中のhard interruptは待機を解除し、応答内toolや次APIを実行しない", async () => {
    const requests: ChatWithToolsParams[] = [];
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const chatWithTools = async function* (request: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
      requests.push(request);
      if (call++ === 0) {
        await firstHold;
        yield { type: "text", text: "境界到達前の応答" };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      yield* textReply("開始してはいけない応答");
    };
    const provider = {
      ...scriptedProvider([], []),
      chat: chatWithTools,
      chatWithTools,
      chatWithVision: chatWithTools,
    } as unknown as LLMProvider;
    const loop = makeLoop(provider);

    const running = loop.run("pause後に中断");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    loop.requestRunPause();
    releaseFirst();
    await vi.waitFor(() => expect(loop.getRunPauseSnapshot().state).toBe("paused"));
    loop.abort();
    await running;

    expect(requests).toHaveLength(1);
    expect(loop.getRunPauseSnapshot().state).toBe("idle");
    expect(loop.isAborted()).toBe(true);
  });

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
