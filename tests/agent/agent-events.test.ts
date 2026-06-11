import { describe, it, expect, vi } from "vitest";
import { AgentEventBus } from "../../src/agent/agent-events.js";

describe("AgentEventBus", () => {
  it("on で登録したリスナーに emit のペイロードが届く", () => {
    const bus = new AgentEventBus();
    const received: string[] = [];
    bus.on("harness_notice", (e) => received.push(`${e.level}:${e.message}`));

    bus.emit("harness_notice", { level: "warn", message: "test" });

    expect(received).toEqual(["warn:test"]);
  });

  it("on の返り値 (解除関数) で購読解除できる", () => {
    const bus = new AgentEventBus();
    const listener = vi.fn();
    const off = bus.on("tool_start", listener);

    bus.emit("tool_start", { callId: "1", name: "bash", summary: "bash ls" });
    off();
    bus.emit("tool_start", { callId: "2", name: "bash", summary: "bash pwd" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount("tool_start")).toBe(0);
  });

  it("off で個別リスナーを解除できる (他のリスナーは残る)", () => {
    const bus = new AgentEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("task_start", a);
    bus.on("task_start", b);

    bus.off("task_start", a);
    bus.emit("task_start", { source: "cli", prompt: "p", timestamp: 0 });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("リスナーの例外は隔離され、他のリスナーと呼び出し元に影響しない", () => {
    const bus = new AgentEventBus();
    const after = vi.fn();
    bus.on("assistant_text", () => {
      throw new Error("listener boom");
    });
    bus.on("assistant_text", after);

    expect(() =>
      bus.emit("assistant_text", { text: "hello", final: true }),
    ).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("async リスナーの rejection も呼び出し元に伝播しない", async () => {
    const bus = new AgentEventBus();
    bus.on("task_complete", async () => {
      throw new Error("async boom");
    });

    expect(() =>
      bus.emit("task_complete", {
        source: "slack",
        outcome: "completed",
        finalResponse: "done",
        iterations: 1,
        durationMs: 10,
        toolsExecuted: 0,
      }),
    ).not.toThrow();
    // unhandled rejection にならないことを確認するため 1 tick 待つ
    await new Promise((r) => setTimeout(r, 0));
  });

  it("emit 中にリスナーが追加されても当該 emit には影響しない (スナップショット)", () => {
    const bus = new AgentEventBus();
    const late = vi.fn();
    bus.on("tool_end", () => {
      bus.on("tool_end", late);
    });

    bus.emit("tool_end", {
      callId: "1",
      name: "grep",
      summary: "grep foo",
      success: true,
      durationMs: 5,
    });

    expect(late).not.toHaveBeenCalled(); // 次の emit からは呼ばれる
  });
});
