import { describe, expect, it, vi } from "vitest";
import { gateLLMProvider, RunApiGate } from "../../src/agent/run-api-gate.js";
import { abortableIterator } from "../../src/agent/agent-loop.js";
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

    expect(gate.requestPause().snapshot.state).toBe("pause_requested");
    void gate.pauseAtBoundary();
    expect(gate.snapshot().state).toBe("paused");
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

  it("pause予約は進行中APIを切断せず、API完了だけでは停止しない (停止は境界で)", async () => {
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
    await first;
    expect(gate.snapshot()).toMatchObject({ state: "pause_requested", inFlight: 0 });
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

  it("AgentLoopが宣言した境界で停止し、停止中は次のAPIを開始しない", async () => {
    const gate = new RunApiGate();
    const provider = gateLLMProvider(
      makeProvider(() => undefined),
      gate,
    );
    gate.beginRun("cli");

    expect(gate.requestPause().snapshot.state).toBe("pause_requested");
    await collectResponse(provider.chat(params));
    expect(gate.snapshot()).toMatchObject({ state: "pause_requested", inFlight: 0 });

    let passed = false;
    const boundary = gate.pauseAtBoundary().then(() => {
      passed = true;
    });
    await vi.waitFor(() => expect(gate.snapshot().state).toBe("paused"));
    expect(passed).toBe(false);
    let secondStarted = false;
    const second = collectResponse(provider.chat(params)).then(() => {
      secondStarted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondStarted).toBe(false);
    expect(gate.resume().status).toBe("resumed");
    await Promise.all([boundary, second]);
    expect(passed).toBe(true);
    expect(secondStarted).toBe(true);
    gate.finishRun();
  });

  describe("abortableIterator 経由で途中で抜けても API 実行中カウントが戻る (2026-10-25 myppt: API実行中=7 で pause 不成立)", () => {
    function streamingProvider(): LLMProvider {
      const reply = async function* (): AsyncGenerator<ChatChunk> {
        yield { type: "text", text: "a" };
        yield { type: "error", error: "server error" };
        yield { type: "done", finishReason: "stop" };
      };
      return {
        providerType: "openai-compat",
        chat: reply,
        chatWithTools: reply,
        chatWithVision: reply,
      } as unknown as LLMProvider;
    }

    it("error チャンクで throw して抜けた時", async () => {
      const gate = new RunApiGate();
      gate.beginRun("cli");
      const provider = gateLLMProvider(streamingProvider(), gate);
      await expect(
        (async () => {
          for await (const chunk of abortableIterator(provider.chat(params), () => false)) {
            if (chunk.type === "error") throw new Error(chunk.error);
          }
        })(),
      ).rejects.toThrow("server error");
      await new Promise((r) => setTimeout(r, 0));
      expect(gate.snapshot().inFlight).toBe(0);
      gate.finishRun();
    });

    it("中断 (isAborted) で抜けた時", async () => {
      const gate = new RunApiGate();
      gate.beginRun("cli");
      const provider = gateLLMProvider(streamingProvider(), gate);
      let aborted = false;
      for await (const chunk of abortableIterator(provider.chat(params), () => aborted)) {
        if (chunk.type === "text") aborted = true;
      }
      await new Promise((r) => setTimeout(r, 0));
      expect(gate.snapshot().inFlight).toBe(0);
      gate.finishRun();
    });

    it("途中で抜けた後でも pause 予約が成立する", async () => {
      const reached = vi.fn();
      const gate = new RunApiGate(reached);
      gate.beginRun("cli");
      const provider = gateLLMProvider(streamingProvider(), gate);
      await (async () => {
        for await (const chunk of abortableIterator(provider.chat(params), () => false)) {
          if (chunk.type === "error") return;
        }
      })();
      await new Promise((r) => setTimeout(r, 0));
      gate.requestPause();

      void gate.pauseAtBoundary();
      expect(gate.snapshot().state).toBe("paused");
      expect(reached).toHaveBeenCalled();
      gate.finishRun();
    });
  });
});
