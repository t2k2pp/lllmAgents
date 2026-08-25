import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopManager } from "../../src/loop/loop-manager.js";
import { createScheduleTools } from "../../src/tools/definitions/schedule.js";

describe("schedule tools", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("one-shotを既定として作成し、内部timer/callbackをlistへ漏らさない", async () => {
    const manager = new LoopManager();
    const runner = vi.fn().mockResolvedValue(true);
    const [create, list] = createScheduleTools(manager, runner);

    const created = await create.execute({ prompt: "check deployment", delay: "10s" });
    expect(created.success).toBe(true);
    expect(JSON.parse(created.output)).toMatchObject({ id: "1", recurring: false, delay: "10s" });

    const listed = await list.execute({});
    const payload = JSON.parse(listed.output);
    expect(payload.schedules).toHaveLength(1);
    expect(payload.schedules[0]).toMatchObject({ id: "1", prompt: "check deployment", recurring: false });
    expect(payload.schedules[0]).not.toHaveProperty("timerId");
    expect(payload.schedules[0]).not.toHaveProperty("runner");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner).toHaveBeenCalledWith("check deployment", "1");
    expect(manager.count).toBe(0);
  });

  it("recurringを作成し、個別またはallで取消できる", async () => {
    const manager = new LoopManager();
    const [create, , remove] = createScheduleTools(manager, async () => true);

    await create.execute({ prompt: "poll CI", delay: "5m", recurring: true });
    await create.execute({ prompt: "poll deploy", delay: "1h", recurring: true });

    expect((await remove.execute({ id: "1" })).success).toBe(true);
    expect(manager.list().map((entry) => entry.id)).toEqual(["2"]);
    expect(JSON.parse((await remove.execute({ all: true })).output)).toMatchObject({ deleted: 1 });
    expect(manager.count).toBe(0);
  });

  it.each([
    [{ prompt: "x", delay: "9s" }, "10秒"],
    [{ prompt: "x", delay: "8d" }, "7日"],
    [{ prompt: "", delay: "10s" }, "prompt"],
    [{ prompt: "x".repeat(4001), delay: "10s" }, "4000"],
    [{ prompt: "x", delay: "tomorrow" }, "delay"],
  ])("不正または危険な作成条件を拒否する: %o", async (params, message) => {
    const manager = new LoopManager();
    const [create] = createScheduleTools(manager, async () => true);

    const result = await create.execute(params);
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
    expect(manager.count).toBe(0);
  });

  it("存在しないIDの取消は恒久エラーとして返す", async () => {
    const manager = new LoopManager();
    const [, , remove] = createScheduleTools(manager, async () => true);

    const result = await remove.execute({ id: "missing" });
    expect(result).toMatchObject({ success: false, errorKind: "permanent" });
  });
});
