import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { TIER_CONTEXT_BUDGETS } from "../../src/agent/capability-tier.js";
import { estimateTokens, MESSAGE_OVERHEAD_TOKENS } from "../../src/agent/token-counter.js";
import { MIN_TOOL_RESULT_TOKENS } from "../../src/agent/tool-result-limit.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider, Message } from "../../src/providers/base-provider.js";
import type { SecurityConfig } from "../../src/config/types.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { clearTodos } from "../../src/tools/definitions/todo-write.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

/**
 * 1 回で増える量の上限を AgentLoop で確かめる (docs/context-reduction-redesign.md §4.3、 §13 タスク 4):
 * 本体呼び出しに出力上限 O が載る、 O に達したら「続きを出力」 で続ける、 同じ応答のツール結果の合計 T、
 * 入りきらない利用者の入力を断る。 モデル名 "test-model-7b" はティア T3 (O=4,096 / 1 件 2,048 / 合計 8,192)。
 */

vi.mock("../../src/agent/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/session-manager.js")>();
  return { ...actual, saveSession: vi.fn() };
});

const T3 = TIER_CONTEXT_BUDGETS.T3;

function securityConfig(allowedTools: string[]): SecurityConfig {
  return { allowedDirectories: [], blockedCommands: [], rules: { allow: [...allowedTools], deny: [], ask: [] } };
}

function scriptedProvider(replies: ChatChunk[][], requests: ChatWithToolsParams[]): LLMProvider {
  let call = 0;
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    // 本体呼び出し (ツール定義つき) だけを台本で答える。 脇の呼び出しは空で返す
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

/** 先に 1 回ツールを呼ぶ (ツールを使わない応答だけの依頼は、 ハーネスが意図の分類などの脇の呼び出しを挟むため) */
function probeCall(id: string): ChatChunk[] {
  return [
    {
      type: "tool_call",
      toolCall: { id, type: "function", function: { name: "big_probe", arguments: JSON.stringify({ tag: id }) } },
    },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function textReply(text: string, finishReason = "stop"): ChatChunk[] {
  return [
    { type: "text", text },
    { type: "done", finishReason },
  ];
}

/** 大きな出力を返すツール (呼び出しごとに引数を変えて反復検出を避ける) */
function makeRegistry(outputChars: number): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "big_probe",
    definition: {
      type: "function",
      function: { name: "big_probe", description: "test probe", parameters: { type: "object", properties: {} } },
    },
    execute: async (args: Record<string, unknown>) => ({
      success: true,
      output: `BEGIN ${String(args.tag)} ${"x".repeat(outputChars)} END`,
    }),
  });
  return registry;
}

function makeLoop(provider: LLMProvider, registry: ToolRegistry, contextWindow = 128_000): AgentLoop {
  return new AgentLoop(
    provider,
    "test-model-7b",
    registry,
    new PermissionManager(securityConfig(registry.getToolNames())),
    contextWindow,
  );
}

function toolResults(messages: Message[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => String(m.content));
}

describe("本体呼び出しの出力上限 O", () => {
  afterEach(() => clearTodos());

  it("本体呼び出しにティアの outputTokenLimit を maxTokens として渡し、 上限で切れたら続きを出させる", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider(
      [probeCall("p1"), textReply("前半の文章です。", "length"), textReply("後半の文章です。")],
      requests,
    );
    const loop = makeLoop(provider, makeRegistry(10));
    await loop.run("長い説明をしてもらえますか？");

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.length).toBeLessThan(10);
    for (const r of requests) expect(r.maxTokens).toBe(T3.outputTokenLimit);
    // 3 回目 (上限で切れた応答の次) は「続きを出力」 の促しを含む
    expect(requests.length).toBeGreaterThanOrEqual(3);
    const second = requests[2].messages.map((m) => String(m.content)).join("\n");
    expect(second).toContain("続きを出力してください");
  });
});

describe("同じ応答のツール結果の合計の上限 T", () => {
  afterEach(() => clearTodos());

  it("1 回の応答で 5 件呼ぶと、 1 件の上限で切り、 合計の残りで切り、 入らない分は本文を省く (合計は T 以下。 入れる順で数える)", async () => {
    const requests: ChatWithToolsParams[] = [];
    const calls: ChatChunk[] = [];
    for (let i = 0; i < 5; i++) {
      calls.push({
        type: "tool_call",
        toolCall: { id: `c${i}`, type: "function", function: { name: "big_probe", arguments: `{"tag":"t${i}"}` } },
      });
    }
    calls.push({ type: "done", finishReason: "tool_calls" });
    const provider = scriptedProvider([calls, textReply("終わりました。")], requests);
    // 1 件 約 11,000 トークン (1 件の上限 2,048 を超える)
    const loop = makeLoop(provider, makeRegistry(40_000));
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      await loop.run("調べてもらえますか？");
    } finally {
      log.mockRestore();
    }

    const results = toolResults(requests[1].messages);
    expect(results).toHaveLength(5);
    const sizes = results.map(estimateTokens);
    for (let i = 0; i < 3; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(T3.toolResultLimitTokens);
      expect(results[i]).toContain(`BEGIN t${i}`);
      expect(results[i]).toContain(`the limit for one tool result is ${T3.toolResultLimitTokens} tokens`);
    }
    // 4 件目: 合計の残り (5 件目の注記の分を残した量) まで切る。 頭と尻尾は残る
    expect(sizes[3]).toBeGreaterThanOrEqual(MIN_TOOL_RESULT_TOKENS);
    expect(results[3]).toContain(`reached their combined limit of ${T3.toolResultTotalTokens} tokens`);
    expect(results[3]).toContain("BEGIN t3");
    expect(results[3]).toContain("END");
    // 5 件目: 残りが最低量に届かないので本文を省き、 何が起きたかと次にどうすればよいかの注記だけ
    expect(results[4]).toContain("[Result omitted by the harness:");
    expect(results[4]).toContain('the "big_probe" call was handled and its result reported success');
    expect(results[4]).not.toContain("BEGIN t4");
    // 合計 (本文 + 1 件の枠) は T 以下
    const total = sizes.reduce((sum, n) => sum + n + MESSAGE_OVERHEAD_TOKENS, 0);
    expect(total).toBeLessThanOrEqual(T3.toolResultTotalTokens);
    // 利用者にも応答ごとに 1 行で見える
    const notices = lines.filter((l) => l.includes("同じ応答のツール結果の合計が上限"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("1 件を短く切り、 1 件は本文を省きました (big_probe×1。");
  });
});

describe("利用者の入力の検査", () => {
  afterEach(() => clearTodos());

  it("入力 + 固定部分 + 最小限の保護部分 + R > W なら送らずに断り、 履歴にも入れない", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider([textReply("はい")], requests);
    const loop = makeLoop(provider, makeRegistry(10), 128_000);
    const notices: string[] = [];
    loop.events.on("harness_notice", (e) => notices.push(e.message));
    let outcome: string | undefined;
    loop.events.on("task_complete", (e) => {
      outcome = e.outcome;
    });
    const before = loop.getHistory().getMessages().length;

    // 全角 10 万字 ≈ 11 万トークン > 128K 枠で受け付けられる量
    await loop.run("あ".repeat(100_000));

    expect(requests).toHaveLength(0);
    expect(loop.getHistory().getMessages().length).toBe(before);
    expect(notices.some((m) => m.includes("受け付けませんでした") && m.includes("ファイルに保存"))).toBe(true);
    expect(outcome).toBe("error");
  });

  it("入る大きさの入力はそのまま送る (境目の数字は context-budget.test.ts)", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider([probeCall("p1"), textReply("状況を確認しました。")], requests);
    const loop = makeLoop(provider, makeRegistry(10), 128_000);
    await loop.run("状況を教えてください？");
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests.length).toBeLessThan(10);
  });
});
