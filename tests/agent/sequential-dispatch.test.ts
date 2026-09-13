import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import type { LLMProvider, ToolCall } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import type { SecurityConfig } from "../../src/config/types.js";
import { ToolRegistry, type ToolResult } from "../../src/tools/tool-registry.js";

function setup(execute: () => Promise<ToolResult>, name = "vision_analyze", background = false) {
  const registry = new ToolRegistry();
  registry.register({
    name,
    definition: {
      type: "function",
      function: {
        name,
        description: "test",
        parameters: { type: "object", properties: { run_in_background: { type: "boolean" } } },
      },
    },
    execute,
  });
  const security: SecurityConfig = {
    allowedDirectories: [],
    blockedCommands: [],
    autoApproveTools: [name],
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
  };
  const loop = new AgentLoop(
    { providerType: "openai-compat" } as LLMProvider,
    "test-model-7b",
    registry,
    new PermissionManager(security),
    8192,
    0.8,
  );
  const calls: ToolCall[] = [1, 2, 3].map((id) => ({
    id: `call-${id}`,
    type: "function",
    function: { name, arguments: background ? '{"run_in_background":true}' : "{}" },
  }));
  (loop as unknown as { runApiGate: { beginRun(source: "cli"): void } }).runApiGate.beginRun("cli");
  loop.getHistory().addAssistantMessage("", calls);
  const run = () =>
    (loop as unknown as { executeToolsParallel(calls: ToolCall[]): Promise<boolean> }).executeToolsParallel(calls);
  return { loop, run };
}

describe("sequential tool dispatch", () => {
  it("既定では複数ツールも同時に起動しない", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const { loop, run } = setup(async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return { success: true, output: "ok" };
    });
    expect(loop.getMaxParallelTools()).toBe(1);
    expect(await run()).toBe(false);
    expect(calls).toBe(3);
    expect(peak).toBe(1);
  });

  it.each([false, true])("429を返す/throwするツールの後は残りを起動しない (throws=%s)", async (throws) => {
    let calls = 0;
    const { loop, run } = setup(async () => {
      calls++;
      if (throws) throw new Error("HTTP 429: rate_limit_exceeded");
      return { success: false, output: "", error: "[azure-gpt] rate_limit_exceeded" };
    });
    expect(await run()).toBe(true);
    expect(calls).toBe(1);
    const results = loop
      .getHistory()
      .getRawMessages()
      .filter((m) => m.role === "tool");
    expect(results).toHaveLength(3);
    expect(results[1].content).toContain("未実行");
  });

  it("通常のツール失敗では後続を一律停止しない", async () => {
    let calls = 0;
    const { run } = setup(async () => {
      calls++;
      return { success: false, output: "", error: "file not found" };
    });
    expect(await run()).toBe(false);
    expect(calls).toBe(3);
  });
});

it("逐次モードではバックグラウンド委任を起動しない", async () => {
  let calls = 0;
  const { loop, run } = setup(
    async () => {
      calls++;
      return { success: true, output: "running" };
    },
    "task",
    true,
  );
  await run();
  expect(calls).toBe(0);
  expect(
    loop
      .getHistory()
      .getRawMessages()
      .filter((m) => m.role === "tool")[0].content,
  ).toContain("バックグラウンド委任はできません");
});
