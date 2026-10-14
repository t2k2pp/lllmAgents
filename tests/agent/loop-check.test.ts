import { beforeEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import type { ChatChunk, LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import type { SecurityConfig } from "../../src/config/types.js";
import { ToolRegistry, type ToolHandler } from "../../src/tools/tool-registry.js";
import { clearTodos, todoAppendTool, todoMarkTool, getCurrentTodos } from "../../src/tools/definitions/todo-write.js";

// 作業回数の上限を「進捗で延長」 (docs/todo-request-elaboration.md 第 3 段 項目 16)。
// 旧実装は固定上限で「Maximum tool iterations reached.」 とだけ出して黙って止まっていた。

const security: SecurityConfig = {
  allowedDirectories: [],
  blockedCommands: [],
  autoApproveTools: ["work"],
  requireApprovalTools: [],
  discordAutoApproveTools: [],
  slackAutoApproveTools: [],
  rules: { allow: [], deny: [], ask: [] },
};

/** 毎回 work ツールを呼ぶだけのモック provider (同一引数の繰り返し検知に掛からないよう引数を変える) */
function alwaysCallsWork(): LLMProvider {
  let n = 0;
  const gen = async function* (): AsyncGenerator<ChatChunk> {
    n++;
    yield {
      type: "tool_call",
      toolCall: { id: `c${n}`, type: "function", function: { name: "work", arguments: JSON.stringify({ step: n }) } },
    };
    yield { type: "done", finishReason: "tool_calls" };
  };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: gen,
    chatWithTools: gen,
    supportsVision: async () => false,
    chatWithVision: gen,
  } as unknown as LLMProvider;
}

async function runWithWork(execute: () => Promise<void>) {
  let calls = 0;
  const tool: ToolHandler = {
    name: "work",
    definition: {
      type: "function",
      function: { name: "work", description: "test", parameters: { type: "object", properties: {} } },
    },
    execute: async () => {
      calls++;
      await execute();
      return { success: true, output: "ok" };
    },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const loop = new AgentLoop(
    alwaysCallsWork(),
    "test-model-7b",
    registry,
    new PermissionManager(security),
    128_000,
    0.8,
  );
  const cap = (loop as unknown as { capability: Record<string, unknown> }).capability;
  Object.assign(cap, { maxIterations: 3, iterationExtension: 2, maxIterationsCeiling: 7 });
  let finalText = "";
  loop.events.on("assistant_text", (e) => {
    if (e.final) finalText = e.text;
  });
  await loop.run("テスト依頼");
  return { calls, finalText };
}

describe("作業回数の上限 (進捗で延長)", () => {
  beforeEach(() => clearTodos());

  it("進捗が無ければ初期上限で止め、 止めた理由と再開方法を最終応答で伝える", async () => {
    const { calls, finalText } = await runWithWork(async () => {});
    expect(calls).toBe(3);
    expect(finalText).toContain("直近 2 回の作業で ToDo の完了もファイルの変更も無かった");
    expect(finalText).toContain("「続けて」");
  });

  it("ToDo の完了が続く限り延長し、 絶対上限で止めて終わったこと・残りを報告する", async () => {
    let n = 0;
    const { calls, finalText } = await runWithWork(async () => {
      n++;
      await todoAppendTool.execute({ items: [{ content: `機能${n}`, status: "pending" }] });
      const added = getCurrentTodos().find((t) => t.content === `機能${n}`);
      // 最後に足した 1 件だけ未完了のまま残す (残りの一覧に出ることを確かめる)
      if (n < 7) await todoMarkTool.execute({ id: added?.id, status: "completed" });
    });
    expect(calls).toBe(7);
    expect(finalText).toContain("絶対上限 (7 回)");
    expect(finalText).toContain("終わったこと (6)");
    expect(finalText).toContain("残り (1):\n- 機能7");
  });
});
