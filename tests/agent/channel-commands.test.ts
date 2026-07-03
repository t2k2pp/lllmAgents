import { describe, it, expect, vi } from "vitest";
import { runChannelCommand, type ChannelCommandDeps } from "../../src/agent/channel-commands.js";
import type { RoomManager, RoomStatus } from "../../src/agent/room-manager.js";
import type { AgentLoop } from "../../src/agent/agent-loop.js";

// docs/room-model-design.md §8 — チャネル(Discord/Slack)からの "/コマンド" 処理

function mkDeps(overrides: Partial<ChannelCommandDeps> = {}): {
  deps: ChannelCommandDeps;
  clear: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
} {
  const clear = vi.fn();
  const exit = vi.fn();
  const status: RoomStatus[] = [
    {
      id: "A",
      active: false,
      replBound: true,
      autoResume: false,
      sessionId: null,
      messageCount: 0,
      title: "",
      surfaces: ["repl"],
    },
    {
      id: "B",
      active: true,
      replBound: false,
      autoResume: true,
      sessionId: "s1",
      messageCount: 3,
      title: "",
      surfaces: ["discord"],
    },
    {
      id: "C",
      active: false,
      replBound: false,
      autoResume: true,
      sessionId: null,
      messageCount: 0,
      title: "",
      surfaces: ["slack"],
    },
  ];
  const roomManager = {
    runInRoom: async (_room: string, fn: () => Promise<unknown>) => fn(),
    status: () => status,
    autoResumeFor: () => true,
    bindingFor: () => "B",
  } as unknown as RoomManager;
  const agent = {
    getHistory: () => ({ clear }),
    exitGoalSeek: exit,
    getModel: () => "test-model",
    getCurrentSessionMessageCount: () => 3,
  } as unknown as AgentLoop;
  const deps: ChannelCommandDeps = {
    roomManager,
    agent,
    room: "B",
    pending: 0,
    ...overrides,
  };
  return { deps, clear, exit };
}

describe("runChannelCommand", () => {
  it("コマンドでない入力は null を返す", async () => {
    const { deps } = mkDeps();
    expect(await runChannelCommand("こんにちは", deps)).toBeNull();
  });

  it("/help は使い方一覧を返す", async () => {
    const { deps } = mkDeps();
    const out = await runChannelCommand("/help", deps);
    expect(out).toContain("利用できるコマンド");
    expect(out).toContain("/clear");
  });

  it("未対応コマンドは案内 + help を返す", async () => {
    const { deps } = mkDeps();
    const out = await runChannelCommand("/foobar", deps);
    expect(out).toContain("未対応のコマンド");
    expect(out).toContain("/foobar");
  });

  it("/room は 3 Room の状態を返す", async () => {
    const { deps } = mkDeps();
    const out = await runChannelCommand("/room", deps);
    expect(out).toContain("Rooms");
    expect(out).toContain("Room A");
    expect(out).toContain("Room B");
    expect(out).toContain("Room C");
  });

  it("/clear は会話履歴をクリアして確認を返す", async () => {
    const { deps, clear, exit } = mkDeps();
    const out = await runChannelCommand("/clear", deps);
    expect(clear).toHaveBeenCalled();
    expect(exit).toHaveBeenCalled();
    expect(out).toContain("クリア");
    expect(out).toContain("Room B");
  });

  it("/status は Room とモデルとキューを含む", async () => {
    const { deps } = mkDeps();
    const out = await runChannelCommand("/status", deps);
    expect(out).toContain("Room: B");
    expect(out).toContain("test-model");
    expect(out).toContain("Queue:");
  });
});
