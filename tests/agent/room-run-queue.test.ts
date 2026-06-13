import { describe, it, expect } from "vitest";
import { RoomRunQueue } from "../../src/agent/room-run-queue.js";

// docs/room-model-design.md §11 — 受信順グローバル FIFO キュー

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("RoomRunQueue", () => {
  it("ジョブは受信順 (FIFO) で直列実行される", async () => {
    const queue = new RoomRunQueue();
    const order: string[] = [];
    const j1 = queue.enqueue(async () => {
      await sleep(30);
      order.push("j1");
    });
    const j2 = queue.enqueue(async () => {
      order.push("j2");
    });
    expect(j1.position).toBe(0);
    expect(j2.position).toBe(1);
    await Promise.all([j1.result, j2.result]);
    expect(order).toEqual(["j1", "j2"]);
  });

  it("ジョブの失敗はチェーンを壊さない", async () => {
    const queue = new RoomRunQueue();
    const j1 = queue.enqueue(async () => {
      throw new Error("boom");
    });
    const j2 = queue.enqueue(async () => "ok");
    await expect(j1.result).rejects.toThrow("boom");
    await expect(j2.result).resolves.toBe("ok");
  });

  it("pending は完了で減る", async () => {
    const queue = new RoomRunQueue();
    const j1 = queue.enqueue(async () => sleep(20));
    expect(queue.pending).toBe(1);
    const j2 = queue.enqueue(async () => undefined);
    expect(queue.pending).toBe(2);
    await Promise.all([j1.result, j2.result]);
    await sleep(1); // finally の反映待ち
    expect(queue.pending).toBe(0);
  });
});
