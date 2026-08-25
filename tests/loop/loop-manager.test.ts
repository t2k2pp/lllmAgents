import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopManager, MAX_ACTIVE_SCHEDULES } from "../../src/loop/loop-manager.js";

describe("LoopManager scheduling safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("one-shotは成功するまでbusyを1秒間隔で延期し、成功後に削除する", async () => {
    const manager = new LoopManager();
    const runner = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    manager.start("check CI", 10_000, "10s", runner, { recurring: false });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(manager.list()[0]).toMatchObject({ runCount: 0, skippedRuns: 1 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(manager.count).toBe(0);
  });

  it("recurring runnerの実行が間隔を超えても同じentryを重複実行しない", async () => {
    const manager = new LoopManager();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn().mockReturnValue(pending);

    manager.start("slow task", 10_000, "10s", runner);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(manager.list()[0].skippedRuns).toBe(1);

    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("runner例外を未処理rejectにせずentryの診断へ記録する", async () => {
    const manager = new LoopManager();
    manager.start("unstable", 10_000, "10s", async () => {
      throw new Error("provider offline");
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(manager.list()[0]).toMatchObject({
      runCount: 0,
      failureCount: 1,
      lastError: "provider offline",
    });
  });

  it("active scheduleを50件に制限する", () => {
    const manager = new LoopManager();
    for (let i = 0; i < MAX_ACTIVE_SCHEDULES; i++) {
      manager.start(`task-${i}`, 60_000, "1m", async () => undefined);
    }

    expect(() => manager.start("overflow", 60_000, "1m", async () => undefined)).toThrow(/50/);
  });
});
