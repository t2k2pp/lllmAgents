import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubAgentManager } from "../../src/agent/sub-agent.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { ChatChunk, ChatParams, LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import {
  setSubAgentManager,
  taskCancelTool,
  taskListTool,
  taskOutputTool,
  taskSendTool,
} from "../../src/tools/definitions/task.js";
import { ToolRegistry, type ToolHandler } from "../../src/tools/tool-registry.js";

function securityConfig(): SecurityConfig {
  return {
    allowedDirectories: [],
    blockedCommands: [],
    autoApproveTools: [],
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
  };
}

function makeManager(provider: LLMProvider, registry = new ToolRegistry(), config = securityConfig()): SubAgentManager {
  return new SubAgentManager(provider, "test-model", registry, new PermissionManager(config));
}

function immediateProvider(result = "completed result secret"): LLMProvider {
  const chat = async function* (): AsyncGenerator<ChatChunk> {
    yield { type: "text", text: result };
    yield { type: "done", finishReason: "stop" };
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

function cancellableProvider(onStarted: (signal: AbortSignal) => void): LLMProvider {
  const chat = async function* (params: ChatParams): AsyncGenerator<ChatChunk> {
    const signal = params.signal;
    if (!signal) throw new Error("AbortSignal was not provided");
    onStarted(signal);
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    yield { type: "done", finishReason: "stop" };
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

describe("background sub-agent lifecycle", () => {
  beforeEach(() => setSubAgentManager(makeManager(immediateProvider())));

  it("完了済みtaskをrunningと誤認せず、取得後に一覧から除く", async () => {
    const manager = makeManager(immediateProvider());
    const id = manager.launchBackground("general-purpose", "state transition", "prompt secret");

    await vi.waitFor(() => expect(manager.listBackgroundTasks()[0]?.status).toBe("completed"));
    expect(manager.isRunning(id)).toBe(false);
    expect(manager.listBackgroundTasks()).toEqual([
      expect.objectContaining({ agentId: id, status: "completed", description: "state transition" }),
    ]);

    const result = await manager.getResult(id);
    expect(result?.result).toBe("completed result secret");
    expect(manager.listBackgroundTasks()).toEqual([]);
  });

  it("一覧へprompt・result本文を露出しない", async () => {
    const manager = makeManager(immediateProvider("result-private-value"));
    manager.launchBackground("general-purpose", "safe metadata", "prompt-private-value");
    await vi.waitFor(() => expect(manager.listBackgroundTasks()[0]?.status).toBe("completed"));

    const serialized = JSON.stringify(manager.listBackgroundTasks());
    expect(serialized).not.toContain("prompt-private-value");
    expect(serialized).not.toContain("result-private-value");
  });

  it("running taskをcancelし、LLMへsignalを伝播して即時に取消結果を返す", async () => {
    let started!: (signal: AbortSignal) => void;
    const startedPromise = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    const manager = makeManager(cancellableProvider(started));
    const id = manager.launchBackground("general-purpose", "cancel target", "wait forever");
    const signal = await startedPromise;

    expect(manager.cancelBackground(id)).toBe("cancelled");
    expect(signal.aborted).toBe(true);
    expect(manager.isRunning(id)).toBe(false);
    expect(manager.listBackgroundTasks()[0]).toEqual(expect.objectContaining({ agentId: id, status: "cancelled" }));

    const result = await manager.getResult(id);
    expect(result).toEqual(
      expect.objectContaining({ agentId: id, success: false, result: "Cancelled by task_cancel." }),
    );
  });

  it("unknown、完了済み、二重cancelを区別する", async () => {
    const manager = makeManager(immediateProvider());
    expect(manager.cancelBackground("missing")).toBe("not_found");

    const finishedId = manager.launchBackground("general-purpose", "finished", "done");
    await vi.waitFor(() => expect(manager.listBackgroundTasks()[0]?.status).toBe("completed"));
    expect(manager.cancelBackground(finishedId)).toBe("already_finished");

    let started!: (signal: AbortSignal) => void;
    const startedPromise = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    const runningManager = makeManager(cancellableProvider(started));
    const runningId = runningManager.launchBackground("general-purpose", "running", "wait");
    await startedPromise;
    expect(runningManager.cancelBackground(runningId)).toBe("cancelled");
    expect(runningManager.cancelBackground(runningId)).toBe("already_finished");
  });

  it("進行中toolの完了後に停止し、後続toolや次iterationを開始しない", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstReleasePromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const registry = new ToolRegistry();
    const handler = (name: string, execute: () => Promise<void>): ToolHandler => ({
      name,
      definition: {
        type: "function",
        function: { name, description: name, parameters: { type: "object", properties: {} } },
      },
      execute: async () => {
        calls.push(name);
        await execute();
        return { success: true, output: name };
      },
    });
    registry.register(
      handler("file_read", async () => {
        firstStarted();
        await firstReleasePromise;
      }),
    );
    registry.register(handler("grep", async () => {}));

    let llmCalls = 0;
    const chat = async function* (): AsyncGenerator<ChatChunk> {
      llmCalls++;
      yield {
        type: "tool_call",
        toolCall: { id: "slow", type: "function", function: { name: "file_read", arguments: "{}" } },
      };
      yield {
        type: "tool_call",
        toolCall: { id: "after", type: "function", function: { name: "grep", arguments: "{}" } },
      };
      yield { type: "done", finishReason: "tool_calls" };
    };
    const provider = {
      ...immediateProvider(),
      chat,
      chatWithTools: chat,
    } as LLMProvider;
    const config = securityConfig();
    config.autoApproveTools = ["file_read", "grep"];
    const manager = makeManager(provider, registry, config);
    const id = manager.launchBackground("general-purpose", "tool cancellation", "run probes");
    await firstStartedPromise;

    expect(manager.cancelBackground(id)).toBe("cancelled");
    releaseFirst();
    await vi.waitFor(() => expect(manager.listBackgroundTasks()[0]?.status).toBe("cancelled"));

    expect(calls).toEqual(["file_read"]);
    expect(llmCalls).toBe(1);
  });

  it("LLM待機中のtaskへ複数の追加指示をFIFOで送り、古い生成を中断して再steerする", async () => {
    let firstStarted!: (signal: AbortSignal) => void;
    const firstStartedPromise = new Promise<AbortSignal>((resolve) => {
      firstStarted = resolve;
    });
    const seenMessages: ChatParams["messages"][] = [];
    let llmCalls = 0;
    const chat = async function* (params: ChatParams): AsyncGenerator<ChatChunk> {
      llmCalls++;
      seenMessages.push(params.messages);
      if (llmCalls === 1) {
        if (!params.signal) throw new Error("AbortSignal was not provided");
        firstStarted(params.signal);
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("steered")), { once: true });
        });
      }
      yield { type: "text", text: "Redirected work is complete." };
      yield { type: "done", finishReason: "stop" };
    };
    const provider = {
      ...immediateProvider(),
      chat,
      chatWithTools: chat,
    } as LLMProvider;
    const manager = makeManager(provider);
    const id = manager.launchBackground("general-purpose", "steer target", "initial prompt", undefined, undefined, 1);
    const firstSignal = await firstStartedPromise;

    expect(manager.sendBackground(id, "first follow-up")).toEqual({ status: "queued", followUpCount: 1 });
    expect(manager.sendBackground(id, "second follow-up")).toEqual({ status: "queued", followUpCount: 2 });
    expect(firstSignal.aborted).toBe(true);

    await vi.waitFor(() => expect(manager.listBackgroundTasks()[0]?.status).toBe("completed"));
    const snapshot = manager.listBackgroundTasks()[0];
    expect(snapshot).toEqual(expect.objectContaining({ agentId: id, followUpCount: 2 }));
    const serializedSnapshot = JSON.stringify(snapshot);
    expect(serializedSnapshot).not.toContain("first follow-up");
    expect(serializedSnapshot).not.toContain("second follow-up");

    const secondTurn = JSON.stringify(seenMessages[1]);
    expect(secondTurn.indexOf("first follow-up")).toBeLessThan(secondTurn.indexOf("second follow-up"));
    expect(secondTurn).toContain("parent-follow-up");
    expect((await manager.getResult(id))?.result).toBe("Redirected work is complete.");
  });

  it("tool実行中の追加指示は現在toolの完了を待ち、同じturnの後続toolをskipする", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstReleasePromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const registry = new ToolRegistry();
    const handler = (name: string, execute: () => Promise<void>): ToolHandler => ({
      name,
      definition: {
        type: "function",
        function: { name, description: name, parameters: { type: "object", properties: {} } },
      },
      execute: async () => {
        calls.push(name);
        await execute();
        return { success: true, output: name };
      },
    });
    registry.register(
      handler("file_read", async () => {
        firstStarted();
        await firstReleasePromise;
      }),
    );
    registry.register(handler("grep", async () => {}));

    const seenMessages: ChatParams["messages"][] = [];
    let llmCalls = 0;
    const chat = async function* (params: ChatParams): AsyncGenerator<ChatChunk> {
      llmCalls++;
      seenMessages.push(params.messages);
      if (llmCalls === 1) {
        yield {
          type: "tool_call",
          toolCall: { id: "slow", type: "function", function: { name: "file_read", arguments: "{}" } },
        };
        yield {
          type: "tool_call",
          toolCall: { id: "stale", type: "function", function: { name: "grep", arguments: "{}" } },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", text: "Steered work is complete." };
      yield { type: "done", finishReason: "stop" };
    };
    const provider = { ...immediateProvider(), chat, chatWithTools: chat } as LLMProvider;
    const config = securityConfig();
    config.autoApproveTools = ["file_read", "grep"];
    const manager = makeManager(provider, registry, config);
    const id = manager.launchBackground("general-purpose", "tool steer", "run probes");
    await firstStartedPromise;

    expect(manager.sendBackground(id, "stop the remaining probe")).toEqual({ status: "queued", followUpCount: 1 });
    releaseFirst();

    await vi.waitFor(() => expect(manager.listBackgroundTasks()[0]?.status).toBe("completed"));
    expect(calls).toEqual(["file_read"]);
    expect(llmCalls).toBe(2);
    const secondTurn = JSON.stringify(seenMessages[1]);
    expect(secondTurn).toContain("stop the remaining probe");
    expect(secondTurn).toContain("Skipped because a parent follow-up was received");
  });

  it("AbortSignalを無視するproviderが返した古いtool callも実行しない", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: (signal: AbortSignal) => void;
    const firstStartedPromise = new Promise<AbortSignal>((resolve) => {
      firstStarted = resolve;
    });
    const firstReleasePromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "grep",
      definition: {
        type: "function",
        function: { name: "grep", description: "stale probe", parameters: { type: "object", properties: {} } },
      },
      execute: async () => {
        calls.push("grep");
        return { success: true, output: "stale" };
      },
    });

    const seenMessages: ChatParams["messages"][] = [];
    let llmCalls = 0;
    const chat = async function* (params: ChatParams): AsyncGenerator<ChatChunk> {
      llmCalls++;
      seenMessages.push(params.messages);
      if (llmCalls === 1) {
        if (!params.signal) throw new Error("AbortSignal was not provided");
        firstStarted(params.signal);
        await firstReleasePromise;
        yield {
          type: "tool_call",
          toolCall: { id: "ignored-abort", type: "function", function: { name: "grep", arguments: "{}" } },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", text: "Fresh direction is complete." };
      yield { type: "done", finishReason: "stop" };
    };
    const provider = { ...immediateProvider(), chat, chatWithTools: chat } as LLMProvider;
    const config = securityConfig();
    config.autoApproveTools = ["grep"];
    const manager = makeManager(provider, registry, config);
    const id = manager.launchBackground("general-purpose", "ignore signal", "old direction");
    const signal = await firstStartedPromise;

    expect(manager.sendBackground(id, "new direction")).toEqual({ status: "queued", followUpCount: 1 });
    expect(signal.aborted).toBe(true);
    releaseFirst();

    await vi.waitFor(() => expect(manager.listBackgroundTasks()[0]?.status).toBe("completed"));
    expect(calls).toEqual([]);
    expect(JSON.stringify(seenMessages[1])).toContain("Skipped because a parent follow-up was received");
  });

  it("追加指示の入力・queue・turn上限とunknown/finishedを区別する", async () => {
    let started!: (signal: AbortSignal) => void;
    const startedPromise = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    const manager = makeManager(cancellableProvider(started));
    const id = manager.launchBackground("general-purpose", "bounded mailbox", "wait", undefined, undefined, 1);
    await startedPromise;

    expect(manager.sendBackground("missing", "message")).toEqual({ status: "not_found" });
    expect(manager.sendBackground(id, "   ")).toEqual({ status: "invalid_message" });
    expect(manager.sendBackground(id, "x".repeat(4001))).toEqual({ status: "message_too_long" });
    for (let i = 0; i < 20; i++) {
      expect(manager.sendBackground(id, `queued-${i}`)).toEqual({ status: "queued", followUpCount: i + 1 });
    }
    expect(manager.sendBackground(id, "overflow")).toEqual({ status: "queue_full" });

    const finishedManager = makeManager(immediateProvider());
    const finishedId = finishedManager.launchBackground("general-purpose", "finished", "done");
    await vi.waitFor(() => expect(finishedManager.listBackgroundTasks()[0]?.status).toBe("completed"));
    expect(finishedManager.sendBackground(finishedId, "too late")).toEqual({ status: "already_finished" });

    let releaseLast!: () => void;
    let lastStarted!: () => void;
    const lastStartedPromise = new Promise<void>((resolve) => {
      lastStarted = resolve;
    });
    const lastReleasePromise = new Promise<void>((resolve) => {
      releaseLast = resolve;
    });
    let llmCalls = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "file_read",
      definition: {
        type: "function",
        function: { name: "file_read", description: "probe", parameters: { type: "object", properties: {} } },
      },
      execute: async () => ({ success: true, output: "ok" }),
    });
    const chat = async function* (): AsyncGenerator<ChatChunk> {
      llmCalls++;
      if (llmCalls === 30) {
        lastStarted();
        await lastReleasePromise;
      }
      yield {
        type: "tool_call",
        toolCall: { id: `call-${llmCalls}`, type: "function", function: { name: "file_read", arguments: "{}" } },
      };
      yield { type: "done", finishReason: "tool_calls" };
    };
    const turnProvider = { ...immediateProvider(), chat, chatWithTools: chat } as LLMProvider;
    const turnConfig = securityConfig();
    turnConfig.autoApproveTools = ["file_read"];
    const turnManager = makeManager(turnProvider, registry, turnConfig);
    const turnId = turnManager.launchBackground(
      "general-purpose",
      "turn limit",
      "keep probing",
      undefined,
      undefined,
      30,
    );
    await lastStartedPromise;
    expect(turnManager.sendBackground(turnId, "one more turn")).toEqual({ status: "turn_limit_reached" });
    releaseLast();
    await vi.waitFor(() => expect(turnManager.listBackgroundTasks()[0]?.status).toBe("failed"));
  });

  it("task_list / task_send / task_cancel / task_outputを一貫した状態で配線する", async () => {
    let started!: (signal: AbortSignal) => void;
    const startedPromise = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    const manager = makeManager(cancellableProvider(started));
    setSubAgentManager(manager);
    const id = manager.launchBackground("general-purpose", "tool wiring", "wait");
    await startedPromise;

    const listed = await taskListTool.execute({});
    expect(JSON.parse(listed.output)).toEqual({
      tasks: [expect.objectContaining({ agentId: id, status: "running" })],
    });

    const sent = await taskSendTool.execute({ agent_id: id, message: "focus on the parser" });
    expect(sent.success).toBe(true);
    expect(JSON.parse(sent.output)).toEqual({ agentId: id, status: "queued", followUpCount: 1 });
    expect(sent.output).not.toContain("focus on the parser");

    const cancelled = await taskCancelTool.execute({ agent_id: id });
    expect(cancelled.success).toBe(true);
    expect(JSON.parse(cancelled.output)).toEqual({ agentId: id, status: "cancelled" });

    const output = await taskOutputTool.execute({ agent_id: id });
    expect(output.success).toBe(false);
    expect(JSON.parse(output.output)).toEqual(
      expect.objectContaining({ agentId: id, result: "Cancelled by task_cancel." }),
    );
  });
});
