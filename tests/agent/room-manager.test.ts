import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SessionData } from "../../src/agent/session-manager.js";
import { getDefaultRoomConfig } from "../../src/agent/room-types.js";
import type { Config } from "../../src/config/types.js";
import type { AgentLoop } from "../../src/agent/agent-loop.js";

// docs/room-model-design.md — RoomManager の swap/borrow-return/move/resume を検証する。
// session-manager(ディスク I/O) と config-manager(saveConfig) をモックし、 in-memory で完結させる。

const h = vi.hoisted(() => {
  const store = new Map<string, SessionData>();
  let counter = 0;
  let clock = 1;
  return {
    store,
    nextId: () => `s${++counter}`,
    tick: () => `t${clock++}`,
    reset: () => { store.clear(); counter = 0; clock = 1; },
  };
});

vi.mock("../../src/config/config-manager.js", () => ({
  saveConfig: vi.fn(),
}));

vi.mock("../../src/agent/session-manager.js", () => ({
  createSession: (model: string, room?: string): SessionData => ({
    meta: { id: h.nextId(), createdAt: "t0", updatedAt: h.tick(), model, messageCount: 0, title: "", room },
    messages: [],
  }),
  loadSession: (id: string): SessionData | null => {
    const s = h.store.get(id);
    return s ? structuredClone(s) : null;
  },
  latestSessionMetaOfRoom: (room: string) => {
    const metas = [...h.store.values()].filter((s) => s.meta.room === room).map((s) => s.meta);
    metas.sort((a, b) => Number(b.updatedAt.slice(1)) - Number(a.updatedAt.slice(1)));
    return metas[0] ? structuredClone(metas[0]) : null;
  },
}));

// モック適用後に import する
const { RoomManager } = await import("../../src/agent/room-manager.js");

/** 実 AgentLoop の代わりに RoomManager が呼ぶメソッドだけを持つ最小スタブ。 */
class FakeAgent {
  session: SessionData = {
    meta: { id: "boot", createdAt: "t0", updatedAt: "t0", model: "m", messageCount: 0, title: "" },
    messages: [],
  };
  getModel(): string { return "m"; }
  getCurrentSessionId(): string { return this.session.meta.id; }
  getCurrentSessionRoom() { return this.session.meta.room; }
  tagSessionRoom(room: "A" | "B" | "C"): void { this.session.meta.room = room; }
  saveCurrentSession(): void {
    this.session.meta.updatedAt = h.tick();
    this.session.meta.messageCount = this.session.messages.length;
    h.store.set(this.session.meta.id, structuredClone(this.session));
  }
  restoreSession(data: SessionData): void { this.session = structuredClone(data); }
}

function mkConfig(): Config {
  return { roomConfig: getDefaultRoomConfig() } as unknown as Config;
}

function bSessions(): SessionData[] {
  return [...h.store.values()].filter((s) => s.meta.room === "B");
}

describe("RoomManager", () => {
  let agent: FakeAgent;
  let rm: InstanceType<typeof RoomManager>;

  beforeEach(() => {
    h.reset();
    agent = new FakeAgent();
    rm = new RoomManager(mkConfig(), agent as unknown as AgentLoop);
  });

  it("既定 binding は REPL=A / Discord=B / Slack=C", () => {
    expect(rm.bindingFor("repl")).toBe("A");
    expect(rm.bindingFor("discord")).toBe("B");
    expect(rm.bindingFor("slack")).toBe("C");
    expect(rm.autoResumeFor("A")).toBe(false);
    expect(rm.autoResumeFor("B")).toBe(true);
    expect(rm.autoResumeFor("C")).toBe(true);
  });

  it("initReplSession は起動セッションを Room A にタグする", () => {
    rm.initReplSession();
    expect(agent.getCurrentSessionRoom()).toBe("A");
    expect(rm.current()).toBe("A");
  });

  it("runInRoom は対象 Room を borrow し、 終了後に resting room へ戻す", async () => {
    rm.initReplSession();
    let roomDuring: string | null = null;
    await rm.runInRoom("B", async () => {
      roomDuring = rm.current();
      agent.session.messages.push({ role: "user", content: "hi" } as never);
    });
    expect(roomDuring).toBe("B");          // 実行中は B
    expect(rm.current()).toBe("A");        // 終了後は resting room A
    expect(agent.getCurrentSessionRoom()).toBe("A");
    const b = bSessions();
    expect(b.length).toBe(1);              // B の会話がディスク保存された
    expect(b[0].messages.length).toBe(1);
  });

  it("同じ Room への 2 回目の run は会話を継続する (新規セッションを作らない)", async () => {
    rm.initReplSession();
    await rm.runInRoom("B", async () => { agent.session.messages.push({ role: "user", content: "1" } as never); });
    await rm.runInRoom("B", async () => { agent.session.messages.push({ role: "user", content: "2" } as never); });
    const b = bSessions();
    expect(b.length).toBe(1);              // 同一セッションを継続
    expect(b[0].messages.length).toBe(2);
  });

  it("moveSurface('repl', 'B') で REPL の現在地が B になる", () => {
    rm.initReplSession();
    rm.moveSurface("repl", "B");
    expect(rm.bindingFor("repl")).toBe("B");
    expect(rm.current()).toBe("B");
  });

  it("setAutoResume が値を変える", () => {
    rm.setAutoResume("A", true);
    expect(rm.autoResumeFor("A")).toBe(true);
    rm.setAutoResume("B", false);
    expect(rm.autoResumeFor("B")).toBe(false);
  });

  it("resumeRoom は会話が無ければ false、 あれば true", async () => {
    rm.initReplSession();
    expect(rm.resumeRoom("B")).toBe(false);          // まだ B の会話なし
    await rm.runInRoom("B", async () => { agent.session.messages.push({ role: "user", content: "x" } as never); });
    expect(rm.resumeRoom("B")).toBe(true);           // B の会話ができた
  });

  it("status は 3 Room 分を返し、 active と replBound を反映する", () => {
    rm.initReplSession();
    const st = rm.status();
    expect(st.map((s) => s.id)).toEqual(["A", "B", "C"]);
    const a = st.find((s) => s.id === "A")!;
    expect(a.active).toBe(true);
    expect(a.replBound).toBe(true);
    expect(st.find((s) => s.id === "B")!.surfaces).toContain("discord");
  });
});
