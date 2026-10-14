import { beforeEach, describe, expect, it } from "vitest";
import { AgentLoop, judgeLoopWindow } from "../../src/agent/agent-loop.js";
import type { ChatChunk, LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import type { SecurityConfig } from "../../src/config/types.js";
import { ToolRegistry, type ToolHandler } from "../../src/tools/tool-registry.js";
import { clearTodos, todoAppendTool, todoMarkTool, getCurrentTodos } from "../../src/tools/definitions/todo-write.js";

// 作業回数の上限は撤廃し、 一定回数ごとのループ点検に置き換え (docs/todo-request-elaboration.md 第 4 段)。
// 進んでいる・毎回違うことをしている限り止めない。 進捗無し + 繰り返しが 2 区間続いたときだけ止めて報告する。

const security: SecurityConfig = {
  allowedDirectories: [],
  blockedCommands: [],
  autoApproveTools: ["work"],
  requireApprovalTools: [],
  discordAutoApproveTools: [],
  slackAutoApproveTools: [],
  rules: { allow: [], deny: [], ask: [] },
};

/**
 * 毎回 work ツールを呼ぶモック provider。 argsFor(n) で n 回目の引数を決める
 * (同じ引数が 3 回連続すると既存の MAX_REPEAT_TOOL 検知が先に働くので、 テストでは連続させない)。
 */
function callsWork(argsFor: (n: number) => unknown): LLMProvider {
  let n = 0;
  const gen = async function* (): AsyncGenerator<ChatChunk> {
    n++;
    yield {
      type: "tool_call",
      toolCall: { id: `c${n}`, type: "function", function: { name: "work", arguments: JSON.stringify(argsFor(n)) } },
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

async function run(argsFor: (n: number) => unknown, execute: (calls: number, loop: AgentLoop) => Promise<void>) {
  let calls = 0;
  let loopRef: AgentLoop | undefined;
  const tool: ToolHandler = {
    name: "work",
    definition: {
      type: "function",
      function: { name: "work", description: "test", parameters: { type: "object", properties: {} } },
    },
    execute: async () => {
      calls++;
      if (loopRef) await execute(calls, loopRef);
      return { success: true, output: "ok" };
    },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const loop = new AgentLoop(
    callsWork(argsFor),
    "test-model-7b",
    registry,
    new PermissionManager(security),
    128_000,
    0.8,
  );
  loopRef = loop;
  const cap = (loop as unknown as { capability: Record<string, unknown> }).capability;
  Object.assign(cap, { loopCheckInterval: 4 });
  let finalText = "";
  loop.events.on("assistant_text", (e) => {
    if (e.final) finalText = e.text;
  });
  await loop.run("テスト依頼");
  return { calls, finalText };
}

describe("judgeLoopWindow", () => {
  it("進捗があれば ok", () => expect(judgeLoopWindow(["a", "a", "a", "a"], true)).toBe("ok"));
  it("進捗が無くても毎回違う呼び出しなら ok (調査を進めている)", () =>
    expect(judgeLoopWindow(["a", "b", "c", "d"], false)).toBe("ok"));
  it("進捗が無く半分以上が繰り返しなら looping", () =>
    expect(judgeLoopWindow(["a", "b", "a", "b"], false)).toBe("looping"));
  it("呼び出しが少ない区間は判断しない", () => expect(judgeLoopWindow(["a", "a"], false)).toBe("ok"));
});

describe("ループ点検 (作業回数の上限なし)", () => {
  beforeEach(() => clearTodos());

  it("進捗が無くても毎回違う調査をしている限り止めない (回数で止めない)", async () => {
    const { calls } = await run(
      (n) => ({ step: n }),
      async (c, loop) => {
        if (c >= 30) loop.abort(); // テストの終了はユーザー中断で行う
      },
    );
    expect(calls).toBe(30);
  });

  it("進捗が続く限り止めない", async () => {
    const { calls } = await run(
      (n) => ({ step: n % 2 }), // 2 種類の呼び出しを交互 (繰り返しは多いが ToDo が毎回進む)
      async (c, loop) => {
        await todoAppendTool.execute({ items: [{ content: `機能${c}`, status: "pending" }] });
        const added = getCurrentTodos().find((t) => t.content === `機能${c}`);
        await todoMarkTool.execute({ id: added?.id, status: "completed" });
        if (c >= 30) loop.abort();
      },
    );
    expect(calls).toBe(30);
  });

  it("進捗が無く同じ呼び出しを回り続けたら、 1 回目は振り返りを促し、 2 回目で止めて理由と残りを報告する", async () => {
    let n = 0;
    const { calls, finalText } = await run(
      (k) => ({ step: k % 2 }), // a, b, a, b ... (連続はしないが繰り返し)
      async () => {
        n++;
        if (n === 1) await todoAppendTool.execute({ items: [{ content: "残っている機能", status: "pending" }] });
      },
    );
    expect(calls).toBe(8); // 点検間隔 4 × 2 区間
    expect(finalText).toContain("ループの疑い");
    expect(finalText).toContain("残り (1):\n- 残っている機能");
    expect(finalText).toContain("「続けて」");
  });
});
