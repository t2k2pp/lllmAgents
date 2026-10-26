import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { findToolPairingError } from "../../src/agent/message-history.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider, Message } from "../../src/providers/base-provider.js";
import type { SecurityConfig } from "../../src/config/types.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { clearTodos } from "../../src/tools/definitions/todo-write.js";
import { ToolRegistry, type ToolResult } from "../../src/tools/tool-registry.js";

/**
 * 1 回の応答のツール結果の途中にハーネスの促しを挟まない (docs/context-reduction-redesign.md §5.4。 2026-10-26 実機の不具合 B)。
 * 実機では 397 件の呼び出しの応答で、 6 件目の todo_append の後に「計画/Todo 過多」 の促し (揮発の user) が入り、
 * 呼び出しと結果の対が切れた履歴になって、 規則 1 の整理が対の検証で失敗し続けた。
 */

vi.mock("../../src/agent/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/session-manager.js")>();
  return { ...actual, saveSession: vi.fn() };
});

function scriptedProvider(replies: ChatChunk[][], requests: ChatWithToolsParams[]): LLMProvider {
  let call = 0;
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    if (!params.tools || params.tools.length === 0) {
      yield { type: "done", finishReason: "stop" };
      return;
    }
    requests.push(JSON.parse(JSON.stringify(params)));
    const current = call++;
    for (const chunk of replies[Math.min(current, replies.length - 1)] ?? []) yield chunk;
  };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: chatWithTools,
    chatWithTools,
    supportsVision: async () => false,
    chatWithVision: chatWithTools,
  } as unknown as LLMProvider;
}

function registryWith(name: string, execute: () => Promise<ToolResult>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name,
    definition: {
      type: "function",
      function: { name, description: "test", parameters: { type: "object", properties: {} } },
    },
    execute,
  });
  return registry;
}

function security(names: string[]): SecurityConfig {
  return { allowedDirectories: [], blockedCommands: [], rules: { allow: names, deny: [], ask: [] } };
}

function manyCalls(name: string, count: number, sameArgs: boolean): ChatChunk[] {
  const chunks: ChatChunk[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push({
      type: "tool_call",
      toolCall: {
        id: `call-${i}`,
        type: "function",
        function: { name, arguments: sameArgs ? '{"x":1}' : JSON.stringify({ i }) },
      },
    });
  }
  chunks.push({ type: "done", finishReason: "tool_calls" });
  return chunks;
}

const done: ChatChunk[] = [
  { type: "text", text: "終わりました。" },
  { type: "done", finishReason: "stop" },
];

/** 送った並びの中で、 tool の結果の直前・直後に挟まった user を探す */
function userBetweenResults(messages: Message[]): number {
  return messages.findIndex(
    (m, i) => m.role === "user" && i > 0 && messages[i - 1].role === "tool" && messages[i + 1]?.role === "tool",
  );
}

describe("1 回の応答の結果の途中にハーネスの促しを挟まない", () => {
  afterEach(() => clearTodos());

  it.each([
    1, 3,
  ])("計画/Todo 過多の促し (T2) は、 その応答の結果を全部入れた後に足す (maxParallelTools=%s)", async (parallel) => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider([manyCalls("todo_append", 12, false), done], requests);
    const registry = registryWith("todo_append", async () => ({ success: true, output: "1 項目を追加しました。" }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = new AgentLoop(
        provider,
        "claude-haiku-4-5",
        registry,
        new PermissionManager(security(["todo_append"])),
        200_000,
      );
      loop.setMaxParallelTools(parallel);
      await loop.run("ToDo を作ってください");

      const raw = loop.getHistory().getRawMessages();
      expect(findToolPairingError(raw)).toBeNull();
      const head = raw.findIndex((m) => m.tool_calls?.length === 12);
      expect(raw.slice(head + 1, head + 13).every((m) => m.role === "tool")).toBe(true);
      const nudge = raw[head + 13];
      expect(nudge.role).toBe("user");
      expect(String(nudge.content)).toContain("計画/Todo の更新が過多です");
      expect(nudge.ephemeral).toBe(true);
      // 次の本体呼び出しの並びでも結果の途中に user が無い
      expect(userBetweenResults(requests[1].messages)).toBe(-1);
    } finally {
      log.mockRestore();
    }
  });

  it("stuck-loop の促し (同じ失敗の繰り返し) も結果の途中に挟まない", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider([manyCalls("flaky", 3, true), done], requests);
    const registry = registryWith("flaky", async () => ({ success: false, output: "", error: "temporary failure" }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = new AgentLoop(
        provider,
        "test-model-7b",
        registry,
        new PermissionManager(security(["flaky"])),
        128_000,
      );
      await loop.run("試してください");
      const raw = loop.getHistory().getRawMessages();
      expect(findToolPairingError(raw)).toBeNull();
      const head = raw.findIndex((m) => m.tool_calls?.length === 3);
      expect(raw.slice(head + 1, head + 4).every((m) => m.role === "tool")).toBe(true);
      expect(raw[head + 4]?.role).toBe("user");
      expect(raw[head + 4]?.ephemeral).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("並列の実行で例外が出た呼び出しにも結果を 1 件付けて対を保つ", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider([manyCalls("boom", 2, false), done], requests);
    const registry = registryWith("boom", async () => {
      throw new Error("kaboom");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = new AgentLoop(
        provider,
        "test-model-7b",
        registry,
        new PermissionManager(security(["boom"])),
        128_000,
      );
      loop.setMaxParallelTools(2);
      await loop.run("試してください");
      expect(findToolPairingError(loop.getHistory().getRawMessages())).toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});
