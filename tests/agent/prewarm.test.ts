import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { LLMLogger } from "../../src/agent/llm-logger.js";
import { buildPrewarmRequest, prewarmSkipReason } from "../../src/agent/prewarm.js";
import type { CacheMissDiagnosis } from "../../src/agent/cache-miss.js";
import type { ReductionEventRecord } from "../../src/agent/reduction-event.js";
import { createSession, type SessionData } from "../../src/agent/session-manager.js";
import { sideCall } from "../../src/agent/side-call.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider, Message } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { clearTodos } from "../../src/tools/definitions/todo-write.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { clearGoal } from "../../src/agent/goal-slot.js";
import { formatPrewarmStatusReport, prewarmCommand } from "../../src/cli/commands/prewarm.js";
import { PrewarmIndicator, prewarmIndicator } from "../../src/cli/prewarm-indicator.js";
import { getDefaultConfig } from "../../src/config/types.js";

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

/**
 * 自動の先読み (context.prewarm.auto) の入切。 既定は切 (§9.1) だが、 自動の経路の試験は入にして回す。
 * 設定ファイルは書かない (試験のホームは並列に走るほかの試験と共有なので、 読み出しだけを差し替える)
 */
const prewarmSetting = { auto: true };
vi.mock("../../src/config/config-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config-manager.js")>();
  return {
    ...actual,
    loadConfig: () => {
      const config = actual.loadConfig();
      return { ...config, context: { ...config.context, prewarm: { auto: prewarmSetting.auto } } };
    },
  };
});

afterEach(() => {
  clearTodos();
  clearGoal();
  vi.restoreAllMocks();
  prewarmSetting.auto = true;
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
  /** 先読みの応答の入力トークン数 (既定 1,000) */
  prewarmPromptTokens?: number;
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
      yield {
        type: "done",
        finishReason: "length",
        usage: { promptTokens: options.prewarmPromptTokens ?? 1000, completionTokens: 1 },
      };
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

/**
 * 古いツール結果を段階 1 で消せるよう、 K (T3 = 3) より多く probe を呼ぶ 1 件の依頼。
 * 規則 2 (依頼の終わり) で整理させるときは、 段階 0〜2 の見込みが最低量 F (= 32,768) に届くよう probe を増やす
 * (結果 1 件は T3 の上限 2,048 トークンまで。 届かなければ規則 2 は見送る。 §4.6)
 */
function longRequest(finalPromptTokens: number, probes = 5): ChatChunk[][] {
  return [
    ...Array.from({ length: probes }, (_, i) => callChunks(`p${i + 1}`, 10_000 + i * 2_000)),
    textChunks("調べ終わりました。", finalPromptTokens),
  ];
}

/** 規則 2 で整理される (段階 0〜2 の見込みが F に届く) 依頼 */
const BOUNDARY_PROBES = 22;

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
    const provider = scriptedProvider(
      [...longRequest(70_000, BOUNDARY_PROBES), textChunks("次の答えです。", 20_000)],
      log,
      [],
    );
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
    const prewarmAt = source.indexOf("repl.prewarmAfterResume()");
    expect(prewarmAt).toBeGreaterThan(0);
    expect(source.indexOf("prewarmAfterResume()", prewarmAt + "repl.prewarmAfterResume()".length)).toBe(-1);
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

describe("先読みの後の本体呼び出しの外れの記録 (cache_miss。 §10.2)", () => {
  /** 先読みには入力 prewarmTokens を、 本体呼び出しには入力 mainTokens・再利用 cached を返す provider */
  function cachedProvider(log: Sent[], prewarmTokens: number, mainTokens: number, cached: number): LLMProvider {
    const base = scriptedProvider([], log, []);
    const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
      if (params.maxTokens === 1) {
        log.push({ kind: "prewarm", params: JSON.parse(JSON.stringify(params)) });
        yield { type: "text", text: "x" };
        yield { type: "done", finishReason: "length", usage: { promptTokens: prewarmTokens, completionTokens: 1 } };
        return;
      }
      if (params.tools === undefined) {
        // 意図・完了の分類 (脇の呼び出し) は台本の provider に任せる
        yield* base.chatWithTools(params);
        return;
      }
      log.push({ kind: "main", params: JSON.parse(JSON.stringify(params)) });
      yield { type: "text", text: "答えです。" };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { promptTokens: mainTokens, completionTokens: 10, cachedTokens: cached },
      };
    };
    return { ...base, chat: chatWithTools, chatWithTools } as unknown as LLMProvider;
  }

  function resumed(provider: LLMProvider): AgentLoop {
    const loop = makeLoop(provider);
    const session = createSession("test-model-7b");
    session.messages = [
      { role: "user", content: "前の質問です" },
      { role: "assistant", content: "前の答えです" },
    ] as Message[];
    loop.restoreSession(session);
    return loop;
  }

  function captureCacheMisses(): CacheMissDiagnosis[] {
    const misses: CacheMissDiagnosis[] = [];
    vi.spyOn(LLMLogger.prototype, "logCacheMiss").mockImplementation((d) => {
      misses.push(structuredClone(d));
    });
    return misses;
  }

  it("再開の先読みが効けば (先読みの入力 − 数トークンを再利用) 外れにしない", async () => {
    const misses = captureCacheMisses();
    const loop = resumed(cachedProvider([], 30_000, 30_400, 29_996));
    await loop.prewarmAfterResume();
    await loop.run("続きの質問です？");
    expect(misses).toHaveLength(0);
  });

  it("再開の先読みの後に外れたら、 先読みと比べ、 並びがずれていないことを記録する (スロットの違い・追い出しを疑う材料)", async () => {
    const misses = captureCacheMisses();
    const loop = resumed(cachedProvider([], 30_000, 30_400, 9_157));
    await loop.prewarmAfterResume();
    await loop.run("続きの質問です？");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({
      against: "prewarm",
      previousPromptTokens: 30_000,
      tokensCached: 9_157,
      causes: ["unknown"],
      expected: false,
      divergence: {
        against: "prewarm",
        settingsChanged: false,
        toolsChanged: false,
        firstDifferentMessage: null,
        previousMessageCount: 3,
        messageCount: 4,
      },
    });
  });

  it("先読みの後に道具を足すと、 外れの記録に道具のずれが出る (2026-10-26 実機の再開の不具合)", async () => {
    const misses = captureCacheMisses();
    const log: Sent[] = [];
    const loop = resumed(cachedProvider(log, 30_000, 30_400, 9_157));
    await loop.prewarmAfterResume();
    loop.getToolRegistry().register({
      name: "late_tool",
      definition: {
        type: "function",
        function: { name: "late_tool", description: "late", parameters: { type: "object", properties: {} } },
      },
      execute: async () => ({ success: true, output: "x" }),
    });
    await loop.run("続きの質問です？");
    expect(misses[0]?.divergence).toMatchObject({
      against: "prewarm",
      toolsChanged: true,
      firstDifferentMessage: null,
    });
    const prewarm = log.find((s) => s.kind === "prewarm");
    const main = log.find((s) => s.kind === "main");
    expect(main?.params.tools).not.toEqual(prewarm?.params.tools);
  });

  it("依頼の終わりの整理の後に先読みを送り終えたら、 その整理は外れの原因に挙げない (先読みが読み込み済みなので想定外の外れ)", async () => {
    const misses = captureCacheMisses();
    const records = captureReductionRecords();
    const provider = scriptedProvider(
      [
        ...longRequest(70_000, BOUNDARY_PROBES),
        [
          { type: "text", text: "次の答えです。" },
          {
            type: "done",
            finishReason: "stop",
            usage: { promptTokens: 66_500, completionTokens: 10, cachedTokens: 0 },
          },
        ],
      ],
      [],
      [],
      { prewarmPromptTokens: 66_000 },
    );
    const loop = makeLoop(provider);
    await loop.run("たくさん調べてください？");
    await loop.waitForPrewarm();
    expect(records.at(-1)).toMatchObject({ trigger: "boundary:request-end", ok: true });
    await loop.run("次の質問です？");
    const miss = misses.at(-1);
    expect(miss).toMatchObject({ against: "prewarm", previousPromptTokens: 66_000, tokensCached: 0, expected: false });
    expect(miss?.causes.some((c) => c.startsWith("reduction:") || c.startsWith("prefix_break:"))).toBe(false);
    expect(miss?.divergence?.firstDifferentMessage).toBeNull();
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
    // 再開の先読みは、 送る前の判定 (次の依頼の始まりと同じ) を済ませてから送る
    await loop.prewarmPrepared();
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
      scriptedProvider([...longRequest(70_000, BOUNDARY_PROBES), textChunks("次の答えです。", 20_000)], log, [], {
        failPrewarm: true,
      }),
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

// ─── 古い並びの先読みを待たない・切る (§9.5。 2026-10-27 実機: 再開の先読み 約 40 万トークンを 1 時間 40 分待った) ───

/** 終わった依頼に古いツール結果が 30 件ある大きな会話 (P ≈ 66,000 > 規則 2 の発火点 55,296。 段階 1 だけで F に届く) */
function bigSession(): SessionData {
  const session = createSession("test-model-7b");
  const messages: Message[] = [{ role: "user", content: "たくさん調べてください" }];
  for (let i = 0; i < 30; i++) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `b${i}`, type: "function", function: { name: "probe", arguments: JSON.stringify({ i }) } }],
    });
    messages.push({ role: "tool", tool_call_id: `b${i}`, content: `結果${i}:${"あ".repeat(2_000)}` });
  }
  messages.push({ role: "assistant", content: "調べ終わりました。" });
  session.messages = messages;
  return session;
}

function smallSession(): SessionData {
  const session = createSession("test-model-7b");
  session.messages = [
    { role: "user", content: "前の質問です" },
    { role: "assistant", content: "前の答えです" },
  ] as Message[];
  return session;
}

/** 先読みの応答を止めておく provider (release で返す)。 切られたら prewarm:aborted を控える */
function heldProvider(log: Sent[], events: string[], replies: ChatChunk[][] = [textChunks("答えです。", 5_000)]) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = scriptedProvider(replies, log, events, { holdPrewarm: () => held });
  return { provider, release: () => release() };
}

function captureSideCalls(): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  vi.spyOn(LLMLogger.prototype, "logSideCall").mockImplementation((r) => {
    records.push(structuredClone(r) as unknown as Record<string, unknown>);
  });
  return records;
}

describe("再開の先読みは、 次の依頼の始まりと同じ判定で整理してから送る (§9.4)", () => {
  it("規則 2 の発火点を超える会話の再開は、 先に整理し、 整理した後の並びを先読みする。 次の依頼の始まりでは整理し直さない", async () => {
    const log: Sent[] = [];
    const loop = makeLoop(scriptedProvider([textChunks("再開後の答えです。", 8_000)], log, []));
    const records = captureReductionRecords();
    loop.restoreSession(bigSession());

    const outcome = await loop.prewarmAfterResume();
    expect(outcome.status).toBe("done");
    await tick();
    // 整理イベントは 1 回 (先読みの前)。 先読みは整理した後の並びで 1 回だけ
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      trigger: "boundary:before-prewarm",
      ok: true,
      summary: { status: "not-needed" },
    });
    expect(records[0].prewarm).toMatchObject({ status: "done" });
    const prewarms = log.filter((s) => s.kind === "prewarm");
    expect(prewarms).toHaveLength(1);
    const kept = prewarms[0].params.messages.filter((m) => String(m.content).includes("あ".repeat(2_000)));
    expect(kept.length).toBeLessThan(30);

    await loop.run("続きの質問です？");
    // 次の依頼の始まり (new-request) では整理し直さない (先読みの並びを捨てない)
    expect(records).toHaveLength(1);
    const next = log.find((s) => s.kind === "main");
    if (next === undefined) throw new Error("再開後の本体呼び出しがありません");
    expectPrewarmIsPrefixOf(prewarms[0].params, next.params);
  });

  it("判定の途中 (整理) で Esc が押されたら先読みせず、 次の依頼の始まりで判定し直す", async () => {
    const log: Sent[] = [];
    const loop = makeLoop(scriptedProvider([textChunks("答えです。", 8_000)], log, []));
    loop.restoreSession(bigSession());
    // 要約の無い整理は一瞬で終わるので、 整理の終わりに Esc が届いた扱いにする
    const original = loop.runReductionEvent.bind(loop);
    vi.spyOn(loop, "runReductionEvent").mockImplementation(async (trigger, size) => {
      loop.abort();
      return await original(trigger, size);
    });
    const outcome = await loop.prewarmAfterResume();
    expect(outcome).toMatchObject({ status: "aborted", kind: "user" });
    await tick();
    expect(log.filter((s) => s.kind === "prewarm")).toHaveLength(0);
  });
});

describe("走っている先読みの並びが古くなったら、 待たずにその場で切る (§9.5)", () => {
  async function resumedHeld(session: SessionData = smallSession()) {
    const log: Sent[] = [];
    const events: string[] = [];
    const held = heldProvider(log, events);
    const loop = makeLoop(held.provider);
    loop.restoreSession(session);
    const prewarm = loop.prewarmAfterResume();
    await loop.prewarmPrepared();
    await tick();
    expect(events).toEqual(["prewarm:start"]);
    return { loop, log, events, prewarm, release: held.release };
  }

  it("履歴の書き換え (申告あり) で切り、 本体呼び出しは待たない", async () => {
    const sideCalls = captureSideCalls();
    const { loop, log, events, prewarm } = await resumedHeld();
    const raw = loop.getHistory().getRawMessages();
    loop.getHistory().replaceMessages([raw[0], { role: "assistant", content: "書き換えた答えです" }], "test-rewrite");
    expect(await prewarm).toMatchObject({ status: "aborted", kind: "stale" });
    expect(events).toEqual(["prewarm:start", "prewarm:aborted"]);
    // 本体は (先読みを待たずに) 送られて終わる
    await loop.run("質問です？");
    expect(log.filter((s) => s.kind === "main")).toHaveLength(1);
    const record = sideCalls.find((r) => r.purpose === "prewarm");
    expect(record).toMatchObject({ abortKind: "stale", trigger: "resume" });
    expect(String(record?.abortReason)).toContain("test-rewrite");
  });

  it("/clear (history.clear) で切る", async () => {
    const { loop, prewarm } = await resumedHeld();
    loop.getHistory().clear();
    expect(await prewarm).toMatchObject({ status: "aborted", kind: "stale" });
  });

  it("道具の登録で切る", async () => {
    const { loop, prewarm } = await resumedHeld();
    loop.getToolRegistry().register({
      name: "late_tool",
      definition: {
        type: "function",
        function: { name: "late_tool", description: "late", parameters: { type: "object", properties: {} } },
      },
      execute: async () => ({ success: true, output: "x" }),
    });
    expect(await prewarm).toMatchObject({ status: "aborted", kind: "stale" });
  });

  it("サンプリングの設定・model の変更で切る", async () => {
    const a = await resumedHeld();
    a.loop.setSamplingParam("temperature", 0.1);
    expect(await a.prewarm).toMatchObject({ status: "aborted", kind: "stale" });
    const b = await resumedHeld();
    b.loop.setModel("other-model-7b");
    expect(await b.prewarm).toMatchObject({ status: "aborted", kind: "stale" });
  });

  it("安全網: 申告の無い書き換え (知らせない経路) でも、 本体呼び出しの前に並びを比べて切り、 待たない", async () => {
    const { loop, log, events, prewarm } = await resumedHeld();
    // 送った並びの中身を、 書き換えの申告をせずに変える
    loop.getHistory().getRawMessages()[1].content = "黙って変えた答えです";
    await tick();
    expect(events).toEqual(["prewarm:start"]);
    await loop.run("質問です？");
    expect(await prewarm).toMatchObject({ status: "aborted", kind: "stale" });
    expect(events.indexOf("prewarm:aborted")).toBeGreaterThan(-1);
    expect(events.indexOf("prewarm:aborted")).toBeLessThan(events.indexOf("main"));
    expect(log.filter((s) => s.kind === "main")).toHaveLength(1);
  });

  it("忘却だけ (段階 0〜2・要約なし) の整理も、 書き換えると決めた時点で切る (本体呼び出しより前)", async () => {
    const log: Sent[] = [];
    const events: string[] = [];
    const held = heldProvider(log, events);
    const loop = makeLoop(held.provider);
    const records = captureReductionRecords();
    loop.restoreSession(bigSession());
    // 整理する前の (大きい) 並びの先読みを走らせておく (再開の先読みは整理してから送るので、 内側から直接送る)
    (loop as unknown as { startPrewarm(t: string): unknown }).startPrewarm("resume");
    await tick();
    expect(events).toEqual(["prewarm:start"]);
    await loop.run("次の質問です？");
    expect(records[0]).toMatchObject({ trigger: "boundary:new-request", ok: true, summary: { status: "not-needed" } });
    expect(events.indexOf("prewarm:aborted")).toBeGreaterThan(-1);
    expect(events.indexOf("prewarm:aborted")).toBeLessThan(events.indexOf("main"));
  });

  it("規則 2 の見送り (書き換えない) では、 まだ使える先読みを切らない", async () => {
    const { loop, events, prewarm, release } = await resumedHeld();
    const result = await loop.runReductionEvent("boundary:new-request");
    expect("skipped" in result && result.skipped).toBe(true);
    await tick();
    expect(events).toEqual(["prewarm:start"]);
    release();
    expect(await prewarm).toMatchObject({ status: "done" });
  });

  it("入力待ちの Esc (prewarmIndicator.cancelFromEscape) は先読みだけを取り消し、 記録に利用者の取り消しと残す", async () => {
    const sideCalls = captureSideCalls();
    const { prewarm } = await resumedHeld();
    expect(prewarmIndicator.isActive()).toBe(true);
    expect(prewarmIndicator.cancelFromEscape()).toBe(true);
    expect(await prewarm).toMatchObject({ status: "aborted", kind: "user" });
    expect(prewarmIndicator.isActive()).toBe(false);
    expect(sideCalls.find((r) => r.purpose === "prewarm")).toMatchObject({ abortKind: "user" });
  });
});

describe("自動の先読みは既定で切、 /prewarm で頼む (§9.1)", () => {
  it("切では、 再開・依頼の終わりの整理・/compact の後に先読みしない", async () => {
    prewarmSetting.auto = false;
    const log: Sent[] = [];
    const loop = makeLoop(
      scriptedProvider([...longRequest(70_000, BOUNDARY_PROBES), textChunks("次の答えです。", 20_000)], log, []),
    );
    const records = captureReductionRecords();
    loop.restoreSession(smallSession());
    expect(await loop.prewarmAfterResume()).toMatchObject({ status: "skipped", reason: "auto-off" });
    await loop.run("たくさん調べてください？");
    await loop.waitForPrewarm();
    expect(records.at(-1)).toMatchObject({ trigger: "boundary:request-end", ok: true, prewarm: null });
    const compact = await loop.runReductionEvent("manual");
    await loop.waitForPrewarm();
    expect(compact.record.prewarm).toBeNull();
    expect(log.filter((s) => s.kind === "prewarm")).toHaveLength(0);
  });

  it("/prewarm は、 次の依頼の始まりと同じ判定で整理してから先読みし、 契機を manual-command と記録する", async () => {
    prewarmSetting.auto = false;
    const sideCalls = captureSideCalls();
    const log: Sent[] = [];
    const loop = makeLoop(scriptedProvider([textChunks("答えです。", 8_000)], log, []));
    const records = captureReductionRecords();
    loop.restoreSession(bigSession());
    const started = loop.prewarmNow();
    if (!started.ok) throw new Error(started.message);
    await started.prepared;
    expect(await started.prewarm).toMatchObject({ status: "done" });
    await tick();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ trigger: "boundary:before-prewarm", ok: true });
    expect(sideCalls.find((r) => r.purpose === "prewarm")).toMatchObject({ trigger: "manual-command" });
    await loop.run("続きの質問です？");
    expect(records).toHaveLength(1);
    const prewarm = log.find((s) => s.kind === "prewarm");
    const next = log.find((s) => s.kind === "main");
    if (!prewarm || !next) throw new Error("先読みか本体呼び出しがありません");
    expectPrewarmIsPrefixOf(prewarm.params, next.params);
  });

  it("/prewarm は、 先読み中・自分のサーバでない・履歴が空なら理由を示して断る", async () => {
    const { provider } = heldProvider([], []);
    const loop = makeLoop(provider);
    expect(loop.prewarmNow()).toMatchObject({ ok: false, message: expect.stringContaining("履歴が空") });
    loop.restoreSession(smallSession());
    const first = loop.prewarmNow();
    expect(first.ok).toBe(true);
    if (first.ok) await first.prepared;
    expect(loop.prewarmNow()).toMatchObject({ ok: false, message: expect.stringContaining("既に先読み中") });
    loop.abort();
    const cloud = makeLoop(scriptedProvider([], [], [], { providerType: "anthropic" }));
    cloud.restoreSession(smallSession());
    expect(cloud.prewarmNow()).toMatchObject({ ok: false, message: expect.stringContaining("anthropic") });
  });

  it("/prewarm on / off は設定 context.prewarm.auto に保存し、 status は入切・走っている先読み・直近の結果を出す", async () => {
    const config = getDefaultConfig();
    const saveConfig = vi.fn();
    const loop = makeLoop(scriptedProvider([], [], []));
    const ctx = { agent: loop, config, saveConfig };
    vi.spyOn(console, "log").mockImplementation(() => {});
    await prewarmCommand.handler(ctx, ["on"]);
    expect(config.context?.prewarm?.auto).toBe(true);
    await prewarmCommand.handler(ctx, ["off"]);
    expect(config.context?.prewarm?.auto).toBe(false);
    expect(saveConfig).toHaveBeenCalledTimes(2);

    const now = 1_000_000;
    const report = formatPrewarmStatusReport(
      {
        auto: false,
        running: { trigger: "manual-command", startedAt: now - 192_000, promptTokens: 401_000, waitingFor: null },
        last: { trigger: "resume", outcome: { status: "aborted", durationMs: 5, kind: "user" }, finishedAt: now },
      },
      now,
    );
    expect(report).toContain("自動の先読み: 切");
    expect(report).toContain("/prewarm、 約 40.1万 トークン、 3分12秒 経過");
    expect(report).toContain("先読みを取り消しました (Esc)");
  });
});

describe("先読みの表示 (prewarmIndicator。 §9.6)", () => {
  function fakeOutput(live: boolean) {
    const calls: Array<[string, string | null]> = [];
    return {
      calls,
      output: {
        live: () => live,
        setStatus: (text: string | null) => calls.push(["status", text]),
        log: (line: string) => calls.push(["log", line]),
      },
    };
  }
  const status = { trigger: "resume" as const, startedAt: 0, promptTokens: 401_000, waitingFor: null };

  it("代替画面: 先読み中 → 待っている → 終わり (状態行を消して 1 行)", () => {
    const { calls, output } = fakeOutput(true);
    const indicator = new PrewarmIndicator(output, () => 192_000);
    indicator.begin(status);
    expect(calls.at(-1)?.[1]).toContain(
      "先読み中 (次の呼び出しに備えて会話をサーバに読ませています) · 約 40.1万 トークン · 3分12秒 · Esc で取り消し",
    );
    indicator.waiting({ ...status, waitingFor: "本体の呼び出し" });
    expect(calls.at(-1)?.[1]).toContain("先読みの終わりを待っています");
    indicator.end({
      status: "aborted",
      durationMs: 1,
      kind: "stale",
      reason: "会話を整理する (履歴を書き換える) と決めたため",
    });
    expect(calls.slice(-2)).toEqual([
      ["status", null],
      ["log", "会話を整理したので、 古い並びの先読みを止めました"],
    ]);
    expect(indicator.isActive()).toBe(false);
  });

  it("パイプ・素通しの画面: 動く行は出さず、 始まりと終わりの行だけ", () => {
    const { calls, output } = fakeOutput(false);
    const indicator = new PrewarmIndicator(output, () => 12_000);
    indicator.begin(status);
    indicator.end({ status: "done", durationMs: 12_300 });
    const logs = calls.filter((c) => c[0] === "log").map((c) => c[1]);
    expect(logs[0]).toContain("先読み中");
    expect(logs[1]).toContain("先読みが終わりました (12秒)");
    expect(calls.filter((c) => c[0] === "status" && c[1] !== null)).toHaveLength(0);
  });

  it("Esc の取り消しは、 先読みの表示が出ているときだけ取り消し関数を呼ぶ", () => {
    const { output } = fakeOutput(true);
    const indicator = new PrewarmIndicator(output);
    const cancel = vi.fn(() => true);
    indicator.setCancelHandler(cancel);
    expect(indicator.cancelFromEscape()).toBe(false);
    indicator.begin(status);
    expect(indicator.cancelFromEscape()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    indicator.end({ status: "aborted", durationMs: 1, kind: "user" });
  });
});
