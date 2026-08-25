import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubAgentManager } from "../../src/agent/sub-agent.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { ChatChunk, ChatParams, LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { setSubAgentManager, taskCancelTool, taskListTool, taskOutputTool } from "../../src/tools/definitions/task.js";
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

  it("task_list / task_cancel / task_outputを一貫した状態で配線する", async () => {
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
