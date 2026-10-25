import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import type { LLMLogger } from "../../src/agent/llm-logger.js";
import { type SideCallRecord, setSideCallSink, sideCall } from "../../src/agent/side-call.js";
import type { SecurityConfig } from "../../src/config/types.js";
import {
  type ChatChunk,
  type ChatWithToolsParams,
  collectResponse,
  type LLMProvider,
} from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { clearTodos } from "../../src/tools/definitions/todo-write.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

/** 脇の呼び出しの入口と、 side_call / cache_miss の記録 (docs/context-reduction-redesign.md §10.2, §10.3) */

vi.mock("../../src/agent/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/session-manager.js")>();
  return { ...actual, saveSession: vi.fn() };
});

function providerFrom(script: (params: ChatWithToolsParams) => AsyncGenerator<ChatChunk>): LLMProvider {
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: script,
    chatWithTools: script,
    supportsVision: async () => false,
    chatWithVision: script,
  } as unknown as LLMProvider;
}

function collectingSink(): SideCallRecord[] {
  const records: SideCallRecord[] = [];
  setSideCallSink({ recordSideCall: (r) => records.push(r) });
  return records;
}

afterEach(() => {
  setSideCallSink(undefined);
  clearTodos();
});

describe("sideCall (脇の呼び出しの入口)", () => {
  it("応答をそのまま流し、 目的・入力・再利用数・所要時間を 1 件記録する", async () => {
    const records = collectingSink();
    const provider = providerFrom(async function* () {
      yield { type: "text", text: '{"type":"task"}' };
      yield { type: "done", finishReason: "stop", usage: { promptTokens: 1200, completionTokens: 8, cachedTokens: 0 } };
    });
    const res = await collectResponse(
      sideCall("intent", provider, { method: "chat", params: { model: "m", messages: [], stream: true } }),
    );
    expect(res.content).toBe('{"type":"task"}');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      purpose: "intent",
      model: "m",
      providerType: "openai-compat",
      tokensIn: 1200,
      tokensOut: 8,
      tokensCached: 0,
      finishReason: "stop",
    });
    expect(records[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(records[0].error).toBeUndefined();
  });

  it("失敗したときも記録し、 失敗はそのまま呼び出し元へ返す", async () => {
    const records = collectingSink();
    const provider = providerFrom(async function* () {
      yield* [];
      throw new Error("ECONNREFUSED");
    });
    await expect(
      collectResponse(
        sideCall("handoff", provider, { method: "chat", params: { model: "m", messages: [], stream: true } }),
      ),
    ).rejects.toThrow("ECONNREFUSED");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: "handoff", error: "ECONNREFUSED" });
  });

  it("途中で読むのをやめたときも記録する", async () => {
    const records = collectingSink();
    const provider = providerFrom(async function* () {
      yield { type: "text", text: "a" };
      yield { type: "text", text: "b" };
      yield { type: "done", finishReason: "stop" };
    });
    for await (const _chunk of sideCall("subagent", provider, {
      method: "chatWithTools",
      params: { model: "m", messages: [], tools: [], stream: true },
    })) {
      break;
    }
    expect(records).toHaveLength(1);
    expect(records[0].purpose).toBe("subagent");
    expect(records[0].error).toBeDefined();
  });
});

describe("AgentLoop: side_call と cache_miss をメインのセッションログに残す", () => {
  it("本体呼び出しの間に脇の呼び出しがあり、 次の本体呼び出しでキャッシュが外れたら原因に挙げる", async () => {
    const replies: ChatChunk[][] = [
      [
        { type: "text", text: "1 件目です。" },
        { type: "done", finishReason: "stop", usage: { promptTokens: 50_000, completionTokens: 10, cachedTokens: 0 } },
      ],
      [
        { type: "text", text: "2 件目です。" },
        { type: "done", finishReason: "stop", usage: { promptTokens: 51_000, completionTokens: 10, cachedTokens: 0 } },
      ],
    ];
    let call = 0;
    const mainReplies = async function* (): AsyncGenerator<ChatChunk> {
      for (const chunk of replies[Math.min(call++, replies.length - 1)]) yield chunk;
    };
    // ツール無しの chat は、 AgentLoop が応答の後に行う意図・完了の分類 (脇の呼び出し) だけが使う
    const classify = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
      const prompt = JSON.stringify(params.messages);
      yield { type: "text", text: prompt.includes("タスク完了") ? '{"type":"other"}' : '{"type":"question"}' };
      yield { type: "done", finishReason: "stop", usage: { promptTokens: 300, completionTokens: 5, cachedTokens: 0 } };
    };
    const main = {
      ...providerFrom(classify),
      chatWithTools: mainReplies,
    } as LLMProvider;
    const registry = new ToolRegistry();
    registry.register({
      name: "noop",
      definition: {
        type: "function",
        function: { name: "noop", description: "test", parameters: { type: "object", properties: {} } },
      },
      execute: async () => ({ success: true, output: "ok" }),
    });
    const security: SecurityConfig = {
      allowedDirectories: [],
      blockedCommands: [],
      rules: { allow: [], deny: [], ask: [] },
    };
    const loop = new AgentLoop(main, "test-model-7b", registry, new PermissionManager(security), 128_000);

    await loop.run("1 件目の状況を教えてください？");
    await loop.run("2 件目の状況を教えてください？");

    const logPath = (loop as unknown as { llmLogger: LLMLogger }).llmLogger.getFilePath();
    const entries = fs
      .readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const sideCalls = entries.filter((e) => e.type === "side_call");
    expect(sideCalls.length).toBeGreaterThan(0);
    expect(sideCalls[0]).toMatchObject({ purpose: "intent", model: "test-model-7b", tokensIn: 300, tokensCached: 0 });
    const misses = entries.filter((e) => e.type === "cache_miss");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ previousPromptTokens: 50_000, tokensCached: 0, expected: false });
    expect(misses[0].causes).toContain("side_call:intent");
  });
});
