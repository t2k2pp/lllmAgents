import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { LLMLogger } from "../../src/agent/llm-logger.js";
import { buildPrewarmRequest, prewarmSkipReason } from "../../src/agent/prewarm.js";
import type { ReductionEventRecord } from "../../src/agent/reduction-event.js";
import { createSession, type SessionData } from "../../src/agent/session-manager.js";
import { sideCall } from "../../src/agent/side-call.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider, Message } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { clearTodos } from "../../src/tools/definitions/todo-write.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { clearGoal } from "../../src/agent/goal-slot.js";

/**
 * 先読み (docs/context-reduction-redesign.md §9。 整理の作り直し タスク 9)。
 *
 * 台本 provider (種類は llamacpp = 先読みを送る自分のサーバ) で AgentLoop を回し、
 * - 先読みの並びが次の本体呼び出しの先頭と一致すること (依頼の終わりの整理・/compact・再開の 3 経路)
 * - 規則 1 (作業の途中) の整理では送らないこと
 * - 先読み中の送信は終わりを待つこと、 Esc で切れること、 先読み中に脇の呼び出しが出ないこと
 * - 出力上限 1 で送ること
 * を確かめる。
 *
 * W = 128,000 / T3 (test-model-7b): R = 17,408、 G = 55,296。 規則 2 は P > 55,296 で起きる。
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

interface Sent {
  kind: "main" | "prewarm" | "side";
  params: ChatWithToolsParams;
}

interface ScriptOptions {
  /** 先読みの応答を返す前に待つもの (待ち合わせの試験用)。 signal が中断されたら error で終える */
  holdPrewarm?: () => Promise<void>;
  /** 先読みを失敗させる */
  failPrewarm?: boolean;
  providerType?: string;
}

/**
 * 本体呼び出しには台本を順に返す。 出力上限 1 の呼び出しは先読みとして控え、 台本を消費しない。
 * 脇の呼び出し (意図・完了の分類・要約) には決まった答えを返す。 log には送った順に控える (送った瞬間の深い写し)
 */
function scriptedProvider(replies: ChatChunk[][], log: Sent[], events: string[], options: ScriptOptions = {}) {
  let main = 0;
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    const copy = JSON.parse(JSON.stringify(params)) as ChatWithToolsParams;
    if (params.maxTokens === 1) {
      log.push({ kind: "prewarm", params: copy });
      events.push("prewarm:start");
      if (options.holdPrewarm) {
        const aborted = new Promise<void>((resolve) => params.signal?.addEventListener("abort", () => resolve()));
        await Promise.race([options.holdPrewarm(), aborted]);
        if (params.signal?.aborted) {
          events.push("prewarm:aborted");
          yield { type: "error", error: "aborted" };
          return;
        }
      }
      events.push("prewarm:end");
      if (options.failPrewarm) {
        yield { type: "error", error: "サーバが落ちています" };
        return;
      }
      yield { type: "text", text: "x" };
      yield { type: "done", finishReason: "length", usage: { promptTokens: 1000, completionTokens: 1 } };
      return;
    }
    const last = String(params.messages.at(-1)?.content ?? "");
    if (last.includes("ユーザーの入力を分類")) {
      log.push({ kind: "side", params: copy });
      yield { type: "text", text: '{"type":"question"}' };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    if (last.includes("タスク完了を宣言しているか")) {
      log.push({ kind: "side", params: copy });
      yield { type: "text", text: '{"type":"completed"}' };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    if (last.includes("<context-summary-request>")) {
      log.push({ kind: "side", params: copy });
      yield { type: "text", text: "要約できません" };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    if (last.includes("side-call-probe")) {
      events.push("side");
      log.push({ kind: "side", params: copy });
      yield { type: "text", text: "ok" };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    events.push("main");
    log.push({ kind: "main", params: copy });
    for (const chunk of replies[Math.min(main++, replies.length - 1)] ?? []) yield chunk;
  };
  return {
    providerType: options.providerType ?? "llamacpp",
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

function callChunks(id: string, promptTokens?: number): ChatChunk[] {
  return [
    {
      type: "tool_call",
      toolCall: { id, type: "function", function: { name: "probe", arguments: JSON.stringify({ tag: id }) } },
    },
    { type: "done", finishReason: "tool_calls", usage: promptTokens === undefined ? undefined : usage(promptTokens) },
  ];
}

function textChunks(text: string, promptTokens?: number): ChatChunk[] {
  return [
    { type: "text", text },
    { type: "done", finishReason: "stop", usage: promptTokens === undefined ? undefined : usage(promptTokens) },
  ];
}

/** 古いツール結果を段階 1 で消せるよう、 K (T3 = 3) より多く probe を呼ぶ 1 件の依頼 */
function longRequest(finalPromptTokens: number): ChatChunk[][] {
  return [
    callChunks("p1", 10_000),
    callChunks("p2", 12_000),
    callChunks("p3", 14_000),
    callChunks("p4", 16_000),
    callChunks("p5", 18_000),
    textChunks("調べ終わりました。", finalPromptTokens),
  ];
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "probe",
    definition: {
      type: "function",
      function: { name: "probe", description: "probe", parameters: { type: "object", properties: {} } },
    },
    execute: async () => ({ success: true, output: "x".repeat(8_000) }),
  });
  return registry;
}

function makeLoop(provider: LLMProvider): AgentLoop {
  const registry = makeRegistry();
  return new AgentLoop(
    provider,
    "test-model-7b",
    registry,
    new PermissionManager(securityConfig(registry.getToolNames())),
    W,
  );
}

/** 先読みの並びが、 次の本体呼び出しの先頭とそのまま一致すること (ツール定義も同じ) */
function expectPrewarmIsPrefixOf(prewarm: ChatWithToolsParams, next: ChatWithToolsParams): void {
  expect(next.tools).toEqual(prewarm.tools);
  expect(next.model).toBe(prewarm.model);
  expect(next.messages.length).toBeGreaterThan(prewarm.messages.length);
  for (let i = 0; i < prewarm.messages.length; i++) {
    expect(next.messages[i], `messages[${i}] (${prewarm.messages[i].role}) が一致しない`).toEqual(prewarm.messages[i]);
  }
  // 先読みには新しい状態通知を付けない (末尾は assistant でもツール結果でもそのまま)。 次の本体呼び出しは、 末尾に足した発言に
  // 状態通知を付ける (それより前の状態通知は、 前の本体呼び出しで送ったもの)
  expect(String(prewarm.messages.at(-1)?.content)).not.toContain("<harness-context>");
  expect(next.messages.at(-1)?.role).toBe("user");
  expect(String(next.messages.at(-1)?.content)).toContain("<harness-context>");
}

/** 送り方の違いが出力上限だけであること (思考・サンプリングの設定は本体と同じ) */
function expectSameSettingsExceptMaxTokens(prewarm: ChatWithToolsParams, main: ChatWithToolsParams): void {
  const strip = ({ messages: _m, maxTokens: _t, signal: _s, ...rest }: ChatWithToolsParams) => rest;
  expect(strip(prewarm)).toEqual(strip(main));
  expect(prewarm.maxTokens).toBe(1);
  expect(main.maxTokens).toBeGreaterThan(1);
}

function captureReductionRecords(): ReductionEventRecord[] {
  const records: ReductionEventRecord[] = [];
  vi.spyOn(LLMLogger.prototype, "logReductionEvent").mockImplementation((r) => {
    records.push(structuredClone(r));
  });
  return records;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("先読みを送る 3 経路で、 先読みの並びが次の本体呼び出しの先頭と一致する", () => {
  it("依頼の終わり (規則 2) の整理の後", async () => {
    const log: Sent[] = [];
    const provider = scriptedProvider([...longRequest(70_000), textChunks("次の答えです。", 20_000)], log, []);
    const loop = makeLoop(provider);
    const records = captureReductionRecords();

    await loop.run("たくさん調べてください？");
    await loop.waitForPrewarm();
    const prewarms = log.filter((s) => s.kind === "prewarm");
    expect(prewarms).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0].trigger).toBe("boundary:request-end");
    expect(records[0].ok).toBe(true);
    expect(records[0].prewarm).toMatchObject({ status: "done" });

    const mainBefore = log.filter((s) => s.kind === "main").length;
    await loop.run("次の質問です？");
    const next = log.filter((s) => s.kind === "main")[mainBefore];
    expectPrewarmIsPrefixOf(prewarms[0].params, next.params);
    expectSameSettingsExceptMaxTokens(prewarms[0].params, next.params);
  });

  it("/compact (manual) の後", async () => {
    const log: Sent[] = [];
    // 依頼の終わりでは発火しない大きさ (P + R + G ≤ W)
    const provider = scriptedProvider([...longRequest(20_000), textChunks("次の答えです。", 15_000)], log, []);
    const loop = makeLoop(provider);
    const records = captureReductionRecords();

    await loop.run("たくさん調べてください？");
    await loop.waitForPrewarm();
    expect(log.filter((s) => s.kind === "prewarm")).toHaveLength(0);

    const result = await loop.runReductionEvent("manual");
    expect(result.ok).toBe(true);
    await loop.waitForPrewarm();
    const prewarms = log.filter((s) => s.kind === "prewarm");
    expect(prewarms).toHaveLength(1);
    expect(records.at(-1)?.prewarm).toMatchObject({ status: "done" });

    const mainBefore = log.filter((s) => s.kind === "main").length;
    await loop.run("次の質問です？");
    const next = log.filter((s) => s.kind === "main")[mainBefore];
    expectPrewarmIsPrefixOf(prewarms[0].params, next.params);
    expectSameSettingsExceptMaxTokens(prewarms[0].params, next.params);
  });

  it("セッションの再開の後 (整理イベントではないので reduction_event は書かない)", async () => {
    const log: Sent[] = [];
    const provider = scriptedProvider([textChunks("再開後の答えです。", 5_000)], log, []);
    const loop = makeLoop(provider);
    const records = captureReductionRecords();
    const session = createSession("test-model-7b");
    session.messages = [
      { role: "user", content: "前の質問です" },
      { role: "assistant", content: "前の答えです" },
    ] as Message[];
    loop.restoreSession(session);

    const outcome = await loop.prewarmAfterResume();
    expect(outcome.status).toBe("done");
    const prewarms = log.filter((s) => s.kind === "prewarm");
    expect(prewarms).toHaveLength(1);

    await loop.run("続きの質問です？");
    const next = log.find((s) => s.kind === "main");
    if (next === undefined) throw new Error("再開後の本体呼び出しがありません");
    expectPrewarmIsPrefixOf(prewarms[0].params, next.params);
    expectSameSettingsExceptMaxTokens(prewarms[0].params, next.params);
    expect(records).toHaveLength(0);
  });

  it("実際の保存セッションの形 (思考・状態通知・揮発・忘却の記録・ToDo・Goal を持つ) の再開でも一致し、 保存した並びをそのまま戻す", async () => {
    const log: Sent[] = [];
    const provider = scriptedProvider([textChunks("再開後の答えです。", 5_000)], log, []);
    const loop = makeLoop(provider);
    const session = createSession("test-model-7b");
    // 2026-10-26 実機で保存された mvp8gvnw-frz6.json と同じ種類の欄を持つ並び
    session.messages = [
      { role: "user", content: "a を読んでください", contextNote: "# Current datetime\n2026/10/26 21:29:01" },
      { role: "system", content: "[忘却の記録] 整理 r-1: 古いツール結果などを履歴から削除しました。" },
      {
        role: "assistant",
        content: "",
        thinking: "a を読む",
        tool_calls: [{ id: "c1", type: "function", function: { name: "probe", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "[忘却済み] probe の結果は履歴から削除しました。" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c2", type: "function", function: { name: "probe", arguments: '{"tag":"todo"}' } }],
      },
      {
        role: "tool",
        tool_call_id: "c2",
        content: "id=t1 を completed に変更しました。",
        contextNote: "# Current datetime\n2026/10/26 21:30:00",
      },
      { role: "assistant", content: "読み終えました。 答えは 65 です。", thinking: "数えた" },
      { role: "user", content: "見直してください", ephemeral: true },
      { role: "assistant", content: "見直しました。" },
    ] as Message[];
    session.todos = [{ id: "t1", content: "a を読む", status: "completed", round: 1 }] as SessionData["todos"];
    session.goal = {
      definition: {
        statement: "ID の数を数える",
        acceptance_criteria: ["数が合っている"],
        created_at: 0,
        register_at_creation: "plain",
      },
      history: [],
    };
    const saved = structuredClone(session.messages);
    loop.restoreSession(session);
    // 保存した並び (状態通知・思考・揮発の印を含む) をそのまま戻す。 落とすと前に送った並びと変わる
    expect(loop.getHistory().getRawMessages()).toEqual(saved);

    const outcome = await loop.prewarmAfterResume();
    expect(outcome.status).toBe("done");
    const prewarms = log.filter((s) => s.kind === "prewarm");
    expect(prewarms).toHaveLength(1);
    expect(String(prewarms[0].params.messages[1]?.content)).toContain("2026/10/26 21:29:01");

    await loop.run("続きの質問です？");
    const next = log.find((s) => s.kind === "main");
    if (next === undefined) throw new Error("再開後の本体呼び出しがありません");
    expectPrewarmIsPrefixOf(prewarms[0].params, next.params);
    expectSameSettingsExceptMaxTokens(prewarms[0].params, next.params);
  });

  it("起動時の --resume は、 道具の登録が全部終わってから先読みする (後から道具を足すと並びがずれる)", () => {
    // 2026-10-26 実機: index.ts が schedule_* の登録より前に先読みを送り、 次の本体呼び出しと道具の並びがずれて
    // 先読み (37,488) の後の再利用が 9,157 (system と道具の途中の保存点) だけになった。 起動の流れは試験で回せないので、
    // index.ts の中の順序を確かめる
    const source = fs.readFileSync(path.join(__dirname, "../../src/index.ts"), "utf8");
    const prewarmAt = source.indexOf("agent.prewarmAfterResume()");
    expect(prewarmAt).toBeGreaterThan(0);
    expect(source.indexOf("agent.prewarmAfterResume()", prewarmAt + 1)).toBe(-1);
    expect(source.lastIndexOf("toolRegistry.register(")).toBeLessThan(prewarmAt);
    expect(source.indexOf("await repl.start()")).toBeGreaterThan(prewarmAt);
  });

  it("末尾がツール結果の履歴 (response_complete で終わった依頼など) でも送り、 次の本体呼び出しの先頭と一致する", async () => {
    const log: Sent[] = [];
    const provider = scriptedProvider([textChunks("再開後の答えです。", 5_000)], log, []);
    const loop = makeLoop(provider);
    const session = createSession("test-model-7b");
    session.messages = [
      { role: "user", content: "前の質問です" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "probe", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "調べた結果" },
    ] as Message[];
    loop.restoreSession(session);

    const outcome = await loop.prewarmAfterResume();
    expect(outcome.status).toBe("done");
    const prewarms = log.filter((s) => s.kind === "prewarm");
    expect(prewarms).toHaveLength(1);
    expect(prewarms[0].params.messages.at(-1)?.role).toBe("tool");

    await loop.run("続きの質問です？");
    const next = log.find((s) => s.kind === "main");
    if (next === undefined) throw new Error("再開後の本体呼び出しがありません");
    expectPrewarmIsPrefixOf(prewarms[0].params, next.params);
  });
});

describe("先読みを送らないとき", () => {
  it("規則 1 (作業の途中) とほかの区切りの整理では送らない (prewarm 欄は null)", async () => {
    const log: Sent[] = [];
    const provider = scriptedProvider(longRequest(20_000), log, []);
    const loop = makeLoop(provider);
    const records = captureReductionRecords();
    await loop.run("たくさん調べてください？");

    const forced = await loop.runReductionEvent("forced");
    expect(forced.ok).toBe(true);
    await loop.waitForPrewarm();
    expect(log.filter((s) => s.kind === "prewarm")).toHaveLength(0);
    expect(records.at(-1)?.trigger).toBe("forced");
    expect(records.at(-1)?.prewarm).toBeNull();
  });

  it("課金される・種類の分からない provider と、 空の履歴には送らず、 理由を記録する", async () => {
    expect(prewarmSkipReason("anthropic", [{ role: "assistant", content: "a" }])?.reason).toBe("not-local-server");
    expect(prewarmSkipReason("azure-openai", [{ role: "assistant", content: "a" }])?.reason).toBe("not-local-server");
    expect(prewarmSkipReason("claude-cli", [{ role: "assistant", content: "a" }])?.reason).toBe("not-local-server");
    expect(prewarmSkipReason("openai-compat", [{ role: "assistant", content: "a" }])?.reason).toBe("not-local-server");
    expect(prewarmSkipReason("llamacpp", [])?.reason).toBe("empty-history");
    expect(prewarmSkipReason("vllm", [{ role: "user", content: "q" }])).toBeNull();
    for (const type of ["llamacpp", "vllm", "lmstudio", "ollama"]) {
      expect(prewarmSkipReason(type, [{ role: "assistant", content: "a" }])).toBeNull();
    }

    const log: Sent[] = [];
    const loop = makeLoop(scriptedProvider([textChunks("答え", 1_000)], log, [], { providerType: "anthropic" }));
    const skipped = vi.spyOn(LLMLogger.prototype, "logPrewarmSkipped");
    const session = createSession("test-model-7b");
    session.messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ] as Message[];
    loop.restoreSession(session);
    const outcome = await loop.prewarmAfterResume();
    expect(outcome).toMatchObject({ status: "skipped", reason: "not-local-server" });
    expect(skipped).toHaveBeenCalledWith(expect.objectContaining({ trigger: "resume", reason: "not-local-server" }));
    expect(log).toHaveLength(0);
  });

  it("buildPrewarmRequest は出力上限だけを 1 にする", () => {
    const params = { model: "m", messages: [], stream: true, maxTokens: 32_768, temperature: 0.6 };
    expect(buildPrewarmRequest({ method: "chat", params })).toEqual({
      method: "chat",
      params: { ...params, maxTokens: 1 },
    });
  });
});

describe("先読み中の待ち合わせ", () => {
  function resumedLoop(provider: LLMProvider): AgentLoop {
    const loop = makeLoop(provider);
    const session = createSession("test-model-7b");
    session.messages = [
      { role: "user", content: "前の質問です" },
      { role: "assistant", content: "前の答えです" },
    ] as Message[];
    loop.restoreSession(session);
    return loop;
  }

  it("先読み中に送信した依頼は、 先読みの終わりを待ってから本体を呼ぶ (切断しない)。 待っている間は 1 行出す", async () => {
    const log: Sent[] = [];
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = resumedLoop(
      scriptedProvider([textChunks("答えです。", 5_000)], log, events, { holdPrewarm: () => held }),
    );
    const notices: string[] = [];
    loop.events.on("harness_notice", (e) => notices.push(e.message));

    const prewarmDone = loop.prewarmAfterResume();
    const running = loop.run("質問です？");
    await tick();
    expect(events).toEqual(["prewarm:start"]);
    expect(notices.some((m) => m.includes("先読み") && m.includes("本体の呼び出し"))).toBe(true);

    release();
    await running;
    expect((await prewarmDone).status).toBe("done");
    expect(events.slice(0, 3)).toEqual(["prewarm:start", "prewarm:end", "main"]);
  });

  it("Esc (abort) は先読みも切り、 待っていた依頼は本体を呼ばずに中断で終わる", async () => {
    const log: Sent[] = [];
    const events: string[] = [];
    const loop = resumedLoop(
      scriptedProvider([textChunks("答えです。", 5_000)], log, events, {
        holdPrewarm: () => new Promise<void>(() => {}),
      }),
    );
    const outcomes: string[] = [];
    loop.events.on("task_complete", (e) => outcomes.push(e.outcome));

    const prewarmDone = loop.prewarmAfterResume();
    const running = loop.run("質問です？");
    await tick();
    loop.abort();
    await running;
    expect((await prewarmDone).status).toBe("aborted");
    expect(events).toEqual(["prewarm:start", "prewarm:aborted"]);
    expect(log.filter((s) => s.kind === "main")).toHaveLength(0);
    expect(outcomes).toEqual(["aborted"]);
  });

  it("先読み中は脇の呼び出しを送らず、 終わってから送る", async () => {
    const log: Sent[] = [];
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = scriptedProvider([], log, events, { holdPrewarm: () => held });
    const loop = resumedLoop(provider);

    const prewarmDone = loop.prewarmAfterResume();
    const side = (async () => {
      for await (const _ of sideCall("intent", provider, {
        method: "chat",
        params: { model: "m", messages: [{ role: "user", content: "side-call-probe" }], stream: true },
      })) {
        // 読み捨てる
      }
    })();
    await tick();
    expect(events).toEqual(["prewarm:start"]);
    release();
    await side;
    await prewarmDone;
    expect(events).toEqual(["prewarm:start", "prewarm:end", "side"]);
  });

  it("先読みの失敗は作業を止めず、 記録と画面の 1 行に出す", async () => {
    const log: Sent[] = [];
    const loop = makeLoop(
      scriptedProvider([...longRequest(70_000), textChunks("次の答えです。", 20_000)], log, [], { failPrewarm: true }),
    );
    const records = captureReductionRecords();
    const notices: Array<{ level: string; message: string }> = [];
    loop.events.on("harness_notice", (e) => notices.push(e));

    await loop.run("たくさん調べてください？");
    await loop.waitForPrewarm();
    await tick();
    expect(records.at(-1)?.prewarm).toMatchObject({ status: "failed", error: "サーバが落ちています" });
    expect(notices.some((n) => n.level === "warn" && n.message.includes("先読みに失敗しました"))).toBe(true);

    const outcomes: string[] = [];
    loop.events.on("task_complete", (e) => outcomes.push(e.outcome));
    await loop.run("次の質問です？");
    expect(outcomes).toEqual(["completed"]);
  });
});
