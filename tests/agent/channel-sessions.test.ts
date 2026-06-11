import { describe, it, expect } from "vitest";
import { ConversationStore, ChannelRunQueue, waitForAgentIdle } from "../../src/agent/channel-sessions.js";
import type { ConversationState } from "../../src/agent/agent-loop.js";

// A-5: docs/channel-session-queue-design.md

function mkState(tag: string): ConversationState {
  // テスト用のダミー状態 (history は参照保持のみのため任意オブジェクトで代用)
  return {
    history: { tag } as unknown as ConversationState["history"],
    todos: [],
    goal: null,
    mode: "forward",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("ConversationStore", () => {
  it("get/set が機能し、未知のキーは null", () => {
    const store = new ConversationStore();
    expect(store.get("a")).toBeNull();
    const s = mkState("a");
    store.set("a", s);
    expect(store.get("a")).toBe(s);
  });

  it("上限超過で最も古い会話を破棄する (LRU)", () => {
    const store = new ConversationStore(2);
    store.set("a", mkState("a"));
    store.set("b", mkState("b"));
    store.get("a"); // a を最新化
    store.set("c", mkState("c")); // b が最古 → 破棄
    expect(store.get("b")).toBeNull();
    expect(store.get("a")).not.toBeNull();
    expect(store.get("c")).not.toBeNull();
    expect(store.size).toBe(2);
  });
});

describe("ChannelRunQueue", () => {
  it("ジョブは FIFO で直列実行される", async () => {
    const queue = new ChannelRunQueue();
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
    const queue = new ChannelRunQueue();
    const j1 = queue.enqueue(async () => {
      throw new Error("boom");
    });
    const j2 = queue.enqueue(async () => "ok");
    await expect(j1.result).rejects.toThrow("boom");
    await expect(j2.result).resolves.toBe("ok");
  });

  it("pending は完了で減る", async () => {
    const queue = new ChannelRunQueue();
    const j1 = queue.enqueue(async () => sleep(20));
    expect(queue.pending).toBe(1);
    const j2 = queue.enqueue(async () => undefined);
    expect(queue.pending).toBe(2);
    await Promise.all([j1.result, j2.result]);
    await sleep(1); // finally の反映待ち
    expect(queue.pending).toBe(0);
  });
});

describe("waitForAgentIdle", () => {
  it("isProcessing が false になるまで待つ", async () => {
    const agent = { isProcessing: true };
    let resolved = false;
    const p = waitForAgentIdle(agent, 10).then(() => {
      resolved = true;
    });
    await sleep(30);
    expect(resolved).toBe(false);
    agent.isProcessing = false;
    await p;
    expect(resolved).toBe(true);
  });

  it("最初から idle なら即時に戻る", async () => {
    await waitForAgentIdle({ isProcessing: false }, 10);
  });
});
