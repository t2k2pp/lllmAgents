import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelProgressTracker } from "../../src/agent/channel-progress.js";
import { AgentEventBus } from "../../src/agent/agent-events.js";

// A-4: docs/channel-progress-design.md

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(minIntervalMs = 5000) {
  const updates: string[] = [];
  const update = vi.fn(async (text: string) => {
    updates.push(text);
  });
  const bus = new AgentEventBus();
  const tracker = new ChannelProgressTracker(update, minIntervalMs).attach(bus);
  return { updates, update, bus, tracker };
}

function emitToolEnd(bus: AgentEventBus, name: string, success = true) {
  bus.emit("tool_end", {
    callId: `id-${name}`,
    name,
    summary: `${name} 実行`,
    success,
    durationMs: 100,
    error: success ? undefined : "boom",
  });
}

describe("ChannelProgressTracker", () => {
  it("最初のイベントは即時に編集する", () => {
    const { updates, bus } = setup();
    bus.emit("tool_start", { callId: "1", name: "bash", summary: "bash npm test" });
    expect(updates.length).toBe(1);
    expect(updates[0]).toContain("▶ bash npm test");
    expect(updates[0]).toContain("0 tools");
  });

  it("間隔内のイベントは coalesce され trailing edge で最新状態が反映される", () => {
    const { updates, bus } = setup(5000);
    bus.emit("tool_start", { callId: "1", name: "a", summary: "tool A" }); // 即時
    emitToolEnd(bus, "a");
    emitToolEnd(bus, "b");
    expect(updates.length).toBe(1); // まだ 5 秒経っていない

    vi.advanceTimersByTime(5000);
    expect(updates.length).toBe(2); // trailing で 1 回にまとまる
    expect(updates[1]).toContain("2 tools");
    expect(updates[1]).toContain("✓ a 実行");
    expect(updates[1]).toContain("✓ b 実行");
  });

  it("失敗ツールは ✗ とエラーを表示する", () => {
    const { updates, bus } = setup();
    emitToolEnd(bus, "bash", false);
    expect(updates[0]).toContain("✗ bash 実行: boom");
  });

  it("warn の harness_notice は表示し、info は無視する", () => {
    const { updates, bus } = setup(0);
    bus.emit("harness_notice", { level: "info", message: "[自己点検 1/2] 検証未実施" });
    expect(updates.length).toBe(0);
    bus.emit("harness_notice", { level: "warn", message: "stuck-loop 検出" });
    expect(updates.length).toBe(1);
    expect(updates[0]).toContain("⚠ stuck-loop 検出");
  });

  it("完了行は直近 5 件に制限される", () => {
    const { updates, bus } = setup(0);
    for (let i = 1; i <= 7; i++) emitToolEnd(bus, `t${i}`);
    const last = updates[updates.length - 1];
    expect(last).not.toContain("t1 実行");
    expect(last).not.toContain("t2 実行");
    expect(last).toContain("t3 実行");
    expect(last).toContain("t7 実行");
    expect(last).toContain("7 tools");
  });

  it("detach 後はイベントが来ても編集しない (予約済み trailing も止まる)", () => {
    const { updates, bus, tracker } = setup(5000);
    bus.emit("tool_start", { callId: "1", name: "a", summary: "tool A" });
    emitToolEnd(bus, "a"); // trailing 予約
    tracker.detach();
    vi.advanceTimersByTime(10000);
    emitToolEnd(bus, "b");
    vi.advanceTimersByTime(10000);
    expect(updates.length).toBe(1); // 最初の即時分のみ
  });

  it("編集関数の失敗は伝播しない (ベストエフォート)", () => {
    const bus = new AgentEventBus();
    const failing = vi.fn(async () => {
      throw new Error("rate limited");
    });
    new ChannelProgressTracker(failing, 0).attach(bus);
    expect(() => emitToolEnd(bus, "a")).not.toThrow();
    expect(failing).toHaveBeenCalled();
  });
});
