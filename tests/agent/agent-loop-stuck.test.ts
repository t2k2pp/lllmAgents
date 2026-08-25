import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import type { LLMProvider, ToolCall } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import type { SecurityConfig } from "../../src/config/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

function makeLoop(): AgentLoop {
  const provider = { providerType: "openai-compat" } as LLMProvider;
  const security: SecurityConfig = {
    allowedDirectories: [],
    blockedCommands: [],
    autoApproveTools: [],
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
  };
  return new AgentLoop(provider, "test-model-7b", new ToolRegistry(), new PermissionManager(security), 8192, 0.8);
}

interface StuckLoopSubject {
  currentIteration: number;
  maybeDetectStuckLoop(call: ToolCall, error: string, kind?: "permanent" | "transient"): void;
}

const call: ToolCall = {
  id: "call-1",
  type: "function",
  function: { name: "file_edit", arguments: '{"path":"missing"}' },
};

describe("AgentLoop stuck-loop circuit breaker", () => {
  it("同一の一過性失敗を警告後も数え続け、5回目で停止する", () => {
    const loop = makeLoop();
    const subject = loop as unknown as StuckLoopSubject;
    for (let iteration = 1; iteration <= 4; iteration++) {
      subject.currentIteration = iteration;
      subject.maybeDetectStuckLoop(call, "temporary failure", "transient");
      expect(loop.isAborted()).toBe(false);
    }
    subject.currentIteration = 5;
    subject.maybeDetectStuckLoop(call, "temporary failure", "transient");
    expect(loop.isAborted()).toBe(true);
  });

  it("恒久エラーは同じ呼出しの2回目で停止する", () => {
    const loop = makeLoop();
    const subject = loop as unknown as StuckLoopSubject;
    subject.currentIteration = 1;
    subject.maybeDetectStuckLoop(call, "403 forbidden", "permanent");
    expect(loop.isAborted()).toBe(false);
    subject.currentIteration = 2;
    subject.maybeDetectStuckLoop(call, "403 forbidden", "permanent");
    expect(loop.isAborted()).toBe(true);
  });
});
