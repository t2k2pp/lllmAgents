import { expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { ContextManager } from "../../src/agent/context-manager.js";
import { MessageHistory } from "../../src/agent/message-history.js";
import { createSession, saveSession, type SessionData } from "../../src/agent/session-manager.js";
import type { LLMProvider } from "../../src/providers/base-provider.js";
vi.mock("../../src/agent/session-manager.js", async (original) => ({
  ...(await original<typeof import("../../src/agent/session-manager.js")>()),
  saveSession: vi.fn(),
}));
it("引き継ぎ後の通常保存が復元先を上書きしない", async () => {
  const saved = new Map<string, SessionData>();
  vi.mocked(saveSession).mockImplementation((session) => {
    saved.set(session.meta.id, structuredClone(session));
  });
  const history = new MessageHistory("sys");
  history.addUserMessage("元の制約と完全な履歴");
  const session = createSession("m");
  const agent = Object.assign(Object.create(AgentLoop.prototype), {
    history,
    session,
    contextManager: new ContextManager({} as LLMProvider, "m", 100_000),
    contextStrategy: { noteApplied: vi.fn() },
  }) as AgentLoop;
  const result = await agent.runHandoffNow("次の作業と保持する制約");
  expect(result.applied).toBe(true);
  const archiveId = result.handoff?.savedSessionId;
  expect(archiveId).toBeTruthy();
  expect(archiveId).not.toBe(session.meta.id);
  agent.saveCurrentSession();
  expect(saved.get(archiveId!)?.messages[0].content).toBe("元の制約と完全な履歴");
  expect(saved.get(session.meta.id)?.messages[0].content).toContain("次の作業と保持する制約");
  vi.mocked(saveSession).mockReset();
});
