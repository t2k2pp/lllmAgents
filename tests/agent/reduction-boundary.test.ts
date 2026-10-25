import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { saveSession, createSession, type SessionData } from "../../src/agent/session-manager.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider, Message } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { clearTodos, todoAppendTool } from "../../src/tools/definitions/todo-write.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { clearGoal } from "../../src/agent/goal-slot.js";

/**
 * 規則 2 (強い区切りでの先回りの整理) と、 依頼 1 件の増分 G の記録・保存・復元
 * (docs/context-reduction-redesign.md §4.4 / §4.5。 整理の作り直し タスク 8)。
 *
 * W = 128,000 / T3 (test-model-7b) で、 R = 17,408、 G = min(既定 80,000, (W − R) ÷ 2 = 55,296) = 55,296。
 * 規則 2 は P > W − R − G = 55,296、 規則 1 は P > W − R = 110,592 で起きる。 P は応答の usage (実数) で決める。
 */

vi.mock("../../src/agent/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/session-manager.js")>();
  return { ...actual, saveSession: vi.fn() };
});

afterEach(() => {
  clearTodos();
  clearGoal();
  vi.restoreAllMocks();
});

const W = 128_000;

function securityConfig(allowedTools: string[]): SecurityConfig {
  return { allowedDirectories: [], blockedCommands: [], rules: { allow: [...allowedTools], deny: [], ask: [] } };
}

/**
 * 本体呼び出しには台本を順に返す。 要約の依頼には型の無い文を返す (要約は失敗し、 設定 continue で段階 0〜2 だけで進む)。
 * 送った本体呼び出しだけを requests に残す
 */
function scriptedProvider(replies: ChatChunk[][], requests: ChatWithToolsParams[]): LLMProvider {
  let main = 0;
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    const last = String(params.messages.at(-1)?.content ?? "");
    // 脇の呼び出し (意図・完了の分類) には決まった答えを返す (台本を消費しない)
    if (last.includes("ユーザーの入力を分類")) {
      yield { type: "text", text: '{"type":"question"}' };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    if (last.includes("タスク完了を宣言しているか")) {
      yield { type: "text", text: '{"type":"completed"}' };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    if (last.includes("<context-summary-request>")) {
      yield { type: "text", text: "要約できません" };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    requests.push(JSON.parse(JSON.stringify(params)));
    for (const chunk of replies[Math.min(main++, replies.length - 1)] ?? []) yield chunk;
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

const usage = (promptTokens: number) => ({ promptTokens, completionTokens: 50 });

function callChunks(id: string, name: string, args: Record<string, unknown>, promptTokens?: number): ChatChunk[] {
  return [
    { type: "tool_call", toolCall: { id, type: "function", function: { name, arguments: JSON.stringify(args) } } },
    { type: "done", finishReason: "tool_calls", usage: promptTokens === undefined ? undefined : usage(promptTokens) },
  ];
}

function textChunks(text: string, promptTokens?: number): ChatChunk[] {
  return [
    { type: "text", text },
    { type: "done", finishReason: "stop", usage: promptTokens === undefined ? undefined : usage(promptTokens) },
  ];
}

function makeRegistry(onProbe?: () => void): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "probe",
    definition: {
      type: "function",
      function: { name: "probe", description: "probe", parameters: { type: "object", properties: {} } },
    },
    execute: async () => {
      onProbe?.();
      return { success: true, output: "x".repeat(8_000) };
    },
  });
  registry.register(todoAppendTool);
  registry.register({
    name: "response_complete",
    definition: {
      type: "function",
      function: { name: "response_complete", description: "done", parameters: { type: "object", properties: {} } },
    },
    execute: async () => ({ success: true, output: "completed" }),
  });
  return registry;
}

function makeLoop(provider: LLMProvider, registry: ToolRegistry): AgentLoop {
  return new AgentLoop(
    provider,
    "test-model-7b",
    registry,
    new PermissionManager(securityConfig(registry.getToolNames())),
    W,
  );
}

/** 整理イベントの発火の種類を、 呼ばれた順に控える (実際の処理はそのまま行う) */
function recordTriggers(): string[] {
  const triggers: string[] = [];
  const real = AgentLoop.prototype.runReductionEvent;
  vi.spyOn(AgentLoop.prototype, "runReductionEvent").mockImplementation(async function (
    this: AgentLoop,
    trigger,
    size,
  ) {
    triggers.push(trigger);
    return await real.call(this, trigger, size);
  });
  return triggers;
}

const appendTodos = (status: "pending" | "completed") => ({
  items: [
    { content: "1 つ目", status },
    { content: "2 つ目", status },
  ],
});

describe("規則 2: 強い区切りでだけ P + R + G > W なら整理する", () => {
  it("依頼の終わり (未完了の ToDo 無し・Goal 無し) は応答の直後に判定する。 次の依頼の始まりでは判定しない", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider(
      [
        callChunks("p1", "probe", { tag: 1 }, 60_000),
        textChunks("1 件目を調べました。", 70_000),
        callChunks("p2", "probe", { tag: 2 }, 30_000),
        textChunks("2 件目を調べました。", 31_000),
      ],
      requests,
    );
    const loop = makeLoop(provider, makeRegistry());
    const triggers = recordTriggers();
    const outcomes: string[] = [];
    loop.events.on("task_complete", (e) => outcomes.push(e.outcome));

    await loop.run("1 件目を調べてください？");
    expect(triggers).toEqual(["boundary:request-end"]);
    // 2 件目: 前の依頼の終わりで判定済みなので「新しい依頼」 では判定しない。 P は小さいので依頼の終わりでも整理しない
    await loop.run("2 件目を調べてください？");
    expect(triggers).toEqual(["boundary:request-end"]);
    expect(outcomes).toEqual(["completed", "completed"]);
    expect(requests).toHaveLength(4);
  });

  it("P + R + G ≤ W なら、 依頼の終わりでも整理しない", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider([textChunks("答えです。", 50_000)], requests);
    const loop = makeLoop(provider, makeRegistry());
    const triggers = recordTriggers();
    await loop.run("質問です？");
    expect(triggers).toEqual([]);
  });

  it("弱い区切り (ToDo が残る応答完了) では整理せず、 次の依頼の始まりでも判定しない", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider(
      [callChunks("t1", "todo_append", appendTodos("pending"), 60_000), textChunks("途中まで進めました。", 70_000)],
      requests,
    );
    const loop = makeLoop(provider, makeRegistry());
    const triggers = recordTriggers();
    const outcomes: string[] = [];
    loop.events.on("task_complete", (e) => outcomes.push(e.outcome));

    await loop.run("作業を進めてください");
    await loop.run("続けてください");
    expect(outcomes).toEqual(["completed", "completed"]);
    expect(triggers).toEqual([]);
  });

  it("ToDo が全部完了したら記録し、 次の本体呼び出しの直前に判定する", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider(
      [
        callChunks("t1", "todo_append", appendTodos("completed"), 60_000),
        callChunks("p1", "probe", { tag: 1 }, 20_000),
        textChunks("終わりました。", 21_000),
      ],
      requests,
    );
    const loop = makeLoop(provider, makeRegistry());
    const triggers = recordTriggers();
    await loop.run("作業してください");
    // 2 回目の本体呼び出しの直前に判定した (依頼の終わりは P が小さいので整理しない)
    expect(triggers).toEqual(["boundary:todos-complete"]);
    expect(requests).toHaveLength(3);
  });

  it("Goal を達成した (評価の直後に記録された) ら、 次の本体呼び出しの直前に判定する", async () => {
    const requests: ChatWithToolsParams[] = [];
    let loop: AgentLoop | null = null;
    // 評価の結果 Goal 達成を記録した状態を、 ツールの実行中に作る (記録は AgentLoop の内部の欄)
    const registry = makeRegistry(() => {
      (loop as unknown as { pendingBoundary: string | null }).pendingBoundary = "goal-achieved";
    });
    const provider = scriptedProvider(
      [callChunks("p1", "probe", { tag: 1 }, 60_000), textChunks("終わりました。", 21_000)],
      requests,
    );
    loop = makeLoop(provider, registry);
    const triggers = recordTriggers();
    await loop.run("作業してください");
    expect(triggers).toEqual(["boundary:goal-achieved"]);
  });

  it("Goal Seek で全部達成して終わった依頼は、 依頼の区切りの判定 1 回にまとめる", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider(
      [
        callChunks("t1", "todo_append", appendTodos("completed"), 30_000),
        callChunks("rc", "response_complete", { summary: "達成しました" }, 70_000),
      ],
      requests,
    );
    const loop = makeLoop(provider, makeRegistry());
    loop.enterGoalSeek(
      {
        statement: "作る",
        acceptance_criteria: ["1 つ目", "2 つ目"],
        created_at: Date.now(),
        register_at_creation: "unknown",
      },
      false,
    );
    const triggers = recordTriggers();
    await loop.run("作業してください");
    expect(loop.getMode()).toBe("forward");
    // ToDo の全部完了は 2 回目の本体呼び出しの直前に判定するが P が小さいので整理しない。
    // Goal の達成は依頼の終わりの判定に含め、 別には判定しない (整理は 1 回だけ)
    expect(triggers).toEqual(["boundary:request-end"]);
  });

  it("Goal が動いている間は、 応答が終わっても依頼の終わりとして判定しない", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider([textChunks("途中です。", 70_000)], requests);
    const loop = makeLoop(provider, makeRegistry());
    loop.enterGoalSeek(
      { statement: "作る", acceptance_criteria: ["1 つ目"], created_at: Date.now(), register_at_creation: "unknown" },
      false,
    );
    const triggers = recordTriggers();
    await loop.run("作業してください");
    expect(triggers).toEqual([]);
  });

  it("再開したセッションでは、 新しい依頼が届いたときに (発言を履歴に入れる前に) 判定する", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider([textChunks("続きをします。", 20_000)], requests);
    const loop = makeLoop(provider, makeRegistry());
    // 古いツール結果が多い履歴 (推定で約 75k トークン)
    const messages: Message[] = [{ role: "user", content: "前の依頼" }];
    for (let i = 0; i < 5; i++) {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{ id: `old${i}`, type: "function", function: { name: "probe", arguments: `{"tag":${i}}` } }],
      });
      messages.push({ role: "tool", content: "x".repeat(60_000), tool_call_id: `old${i}` });
    }
    messages.push({ role: "assistant", content: "前の答え" });
    const session = createSession("test-model-7b");
    session.messages = messages;
    loop.restoreSession(session);
    const triggers = recordTriggers();

    await loop.run("次の依頼です");
    expect(triggers).toEqual(["boundary:new-request"]);
    // 整理は新しい発言の前に済んでいる: 最初の本体呼び出しは古い結果が消えた並びに新しい発言を足したもの
    const sent = requests[0].messages.map((m) => String(m.content));
    expect(sent.filter((c) => c.startsWith("[忘却済み]")).length).toBeGreaterThan(0);
    expect(sent.at(-1)).toContain("次の依頼です");
  });
});

describe("依頼 1 件の増分 G と要約後の渡し直しの保存・復元", () => {
  function lastSaved(): SessionData {
    const saved = vi.mocked(saveSession).mock.calls.at(-1)?.[0] as SessionData;
    return JSON.parse(JSON.stringify(saved)) as SessionData;
  }

  it("依頼の始まり・本体呼び出し・依頼の終わりで G を測り、 セッションに保存して再開後も使う", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider(
      [callChunks("p1", "probe", { tag: 1 }, 10_000), textChunks("調べました。", 14_000)],
      requests,
    );
    const loop = makeLoop(provider, makeRegistry());
    await loop.run("調べてください？");
    loop.saveCurrentSession();
    const saved = lastSaved();
    // 増分 = 最後の入力 14,000 + 出力 50 − 最初の入力 10,000
    expect(saved.requestGrowth).toEqual({ version: 1, recent: [4_050], current: null });

    const loop2 = makeLoop(scriptedProvider([textChunks("はい、 続けます。", 1_000)], []), makeRegistry());
    loop2.restoreSession(saved);
    loop2.saveCurrentSession();
    expect(lastSaved().requestGrowth).toEqual({ version: 1, recent: [4_050], current: null });
  });

  it("依頼の途中で保存したときは途中の分も持つ (一時停止・再開をはさんでも失わない)", async () => {
    const requests: ChatWithToolsParams[] = [];
    let loop: AgentLoop | null = null;
    const registry = makeRegistry(() => loop?.saveCurrentSession());
    const provider = scriptedProvider(
      [callChunks("p1", "probe", { tag: 1 }, 10_000), textChunks("調べました。", 14_000)],
      requests,
    );
    loop = makeLoop(provider, registry);
    await loop.run("調べてください？");
    const midRequest = vi
      .mocked(saveSession)
      .mock.calls.map((c) => JSON.parse(JSON.stringify(c[0])) as SessionData)
      .find((s) => s.requestGrowth?.current !== null && s.requestGrowth?.current !== undefined);
    expect(midRequest?.requestGrowth?.current).toMatchObject({ firstPromptTokens: 10_000, lastPromptTokens: 10_000 });
  });

  it("保存された記録が壊れていれば、 黙って空にせず知らせる", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loop = makeLoop(scriptedProvider([textChunks("はい、 続けます。")], []), makeRegistry());
    const session = createSession("test-model-7b");
    (session as { requestGrowth?: unknown }).requestGrowth = { version: 2 };
    loop.restoreSession(session);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("増分の記録を読めませんでした");
    loop.saveCurrentSession();
    expect(lastSaved().requestGrowth).toEqual({ version: 1, recent: [], current: null });
  });

  it("要約後の渡し直しの預かりは、 保存・再開をはさんでも失わず、 添えたら保存からも消える", async () => {
    const requests: ChatWithToolsParams[] = [];
    const loop = makeLoop(scriptedProvider([textChunks("はい、 続けます。")], requests), makeRegistry());
    loop.getHistory().queueStateHandover("# After context reduction\n- /src/app.ts");
    loop.saveCurrentSession();
    const saved = lastSaved();
    expect(saved.pendingStateHandover).toBe("# After context reduction\n- /src/app.ts");

    const loop2 = makeLoop(scriptedProvider([textChunks("はい、 続けます。")], requests), makeRegistry());
    loop2.restoreSession(saved);
    expect(loop2.getHistory().getPendingStateHandover()).toBe("# After context reduction\n- /src/app.ts");
    await loop2.run("続けてください");
    expect(JSON.stringify(requests[0].messages)).toContain("/src/app.ts");
    loop2.saveCurrentSession();
    expect(lastSaved()).not.toHaveProperty("pendingStateHandover");
  });
});
