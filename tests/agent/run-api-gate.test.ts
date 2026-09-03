import { describe, expect, it, vi } from "vitest";
import { gateLLMProvider, RunApiGate } from "../../src/agent/run-api-gate.js";
import { collectResponse, type ChatChunk, type LLMProvider } from "../../src/providers/base-provider.js";

function makeProvider(onStart: (method: string) => void): LLMProvider {
  const reply = (method: string) =>
    async function* (): AsyncGenerator<ChatChunk> {
      onStart(method);
      yield { type: "done", finishReason: "stop" };
    };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: reply("chat"),
    chatWithTools: reply("chatWithTools"),
    supportsVision: async () => false,
    chatWithVision: reply("chatWithVision"),
  } as unknown as LLMProvider;
}

const params = { model: "local", messages: [], stream: true } as const;

describe("RunApiGate", () => {
  it("pause中はchat/chatWithTools/chatWithVisionの全main API経路を開始しない", async () => {
    const starts: string[] = [];
    const reached = vi.fn();
    const gate = new RunApiGate(reached);
    const provider = gateLLMProvider(
      makeProvider((method) => starts.push(method)),
      gate,
    );
    gate.beginRun("cli");

    expect(gate.requestPause().snapshot.state).toBe("paused");
    expect(reached).toHaveBeenCalledOnce();
    const calls = [
      collectResponse(provider.chat(params)),
      collectResponse(provider.chatWithTools({ ...params, tools: [] })),
      collectResponse(provider.chatWithVision(params)),
    ];
    let toolCheckpointPassed = false;
    const toolCheckpoint = gate.waitUntilRunning().then(() => {
      toolCheckpointPassed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(starts).toEqual([]);
    expect(toolCheckpointPassed).toBe(false);

    expect(gate.resume().status).toBe("resumed");
    await Promise.all([...calls, toolCheckpoint]);
    expect(starts.sort()).toEqual(["chat", "chatWithTools", "chatWithVision"].sort());
    expect(toolCheckpointPassed).toBe(true);
    expect(gate.snapshot().inFlight).toBe(0);
    gate.finishRun();
  });

  it("進行中APIを切断せず完了後にpausedへ遷移し、次のAPIを待たせる", async () => {
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let starts = 0;
    const raw = makeProvider(() => {
      starts++;
    });
    raw.chat = async function* (): AsyncGenerator<ChatChunk> {
      starts++;
      if (starts === 1) await firstHold;
      yield { type: "done", finishReason: "stop" };
    };
    const gate = new RunApiGate();
    const provider = gateLLMProvider(raw, gate);
    gate.beginRun("cli");

    const first = collectResponse(provider.chat(params));
    await vi.waitFor(() => expect(starts).toBe(1));
    expect(gate.requestPause().snapshot.state).toBe("pause_requested");
    releaseFirst();
    await vi.waitFor(() => expect(gate.snapshot().state).toBe("paused"));

    const second = collectResponse(provider.chat(params));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(starts).toBe(1);
    expect(gate.resume().status).toBe("resumed");
    await Promise.all([first, second]);
    expect(starts).toBe(2);
    gate.finishRun();
  });

  it("CLI以外のrunは制御せず、pause予約は境界到達前に取り消せる", async () => {
    const gate = new RunApiGate();
    gate.beginRun("discord");
    expect(gate.requestPause().status).toBe("not_cli");
    expect(gate.resume().status).toBe("not_cli");
    gate.finishRun();

    gate.beginRun("cli");
    const token = await gate.enterRequest();
    expect(token).not.toBeNull();
    expect(gate.requestPause().status).toBe("requested");
    expect(gate.resume().status).toBe("request_cancelled");
    if (token) gate.leaveRequest(token);
    expect(gate.snapshot().state).toBe("running");
    gate.finishRun();
  });

  it("durable pauseはAPI完了だけでは停止せず、AgentLoopが宣言した安全境界で停止する", async () => {
    const gate = new RunApiGate();
    const provider = gateLLMProvider(
      makeProvider(() => undefined),
      gate,
    );
    gate.beginRun("cli");

    expect(gate.requestPause("durable").snapshot.state).toBe("pause_requested");
    await collectResponse(provider.chat(params));
    expect(gate.snapshot()).toMatchObject({ state: "pause_requested", inFlight: 0, mode: "durable" });

    let passed = false;
    const boundary = gate.pauseAtDurableBoundary().then(() => {
      passed = true;
    });
    await vi.waitFor(() => expect(gate.snapshot().state).toBe("paused"));
    expect(passed).toBe(false);
    expect(gate.resume().status).toBe("resumed");
    await boundary;
    expect(passed).toBe(true);
    gate.finishRun();
  });
});
