import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { clearGoal } from "../../src/agent/goal-slot.js";
import { LLMLogger } from "../../src/agent/llm-logger.js";
import { MessageHistory } from "../../src/agent/message-history.js";
import type { ReductionEventRecord } from "../../src/agent/reduction-event.js";
import { TOMBSTONE_MARKER } from "../../src/agent/reduction-stages.js";
import { SUMMARY_MESSAGE_CLOSE, SUMMARY_MESSAGE_OPEN } from "../../src/agent/reduction-summary.js";
import { createSession } from "../../src/agent/session-manager.js";
import {
  buildTaskPointerMessage,
  isTaskHandoffExcerptMessage,
  isTaskPointerMessage,
  type TaskHandoffDoc,
  TaskHandoffStore,
} from "../../src/agent/task-handoff.js";
import { TASK_HANDOFF_UPDATE_TAG, TASK_SWITCH_TAG } from "../../src/agent/task-handoff-tracker.js";
import { estimateMessageTokens } from "../../src/agent/token-counter.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { ChatChunk, ChatWithToolsParams, LLMProvider, Message } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { clearTodos } from "../../src/tools/definitions/todo-write.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

/**
 * タスクの引き継ぎ文書を AgentLoop で回す (docs/task-handoff-design.md §5・§6)。
 * 2026-11-07 の失敗 (要約 21 件 + 別の依頼で below-minimum の見送り) を模した回帰を含む。
 */

vi.mock("../../src/agent/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/session-manager.js")>();
  return { ...actual, saveSession: vi.fn() };
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-loop-"));
});
afterEach(() => {
  clearTodos();
  clearGoal();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const W = 131_072;

interface Script {
  /** 本体呼び出しへの返事 (順に) */
  main: ChatChunk[][];
  /** 続きか別かの答え */
  taskSwitch?: string;
  /** 判断の節の更新の答え */
  update?: string;
}

interface Calls {
  main: ChatWithToolsParams[];
  updates: number;
  switches: number;
}

function scriptedProvider(script: Script, calls: Calls): LLMProvider {
  let main = 0;
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    const last = String(params.messages.at(-1)?.content ?? "");
    const reply = (text: string): ChatChunk[] => [
      { type: "text", text },
      { type: "done", finishReason: "stop" },
    ];
    let chunks: ChatChunk[];
    if (last.includes("ユーザーの入力を分類")) chunks = reply('{"type":"task"}');
    else if (last.includes("タスク完了を宣言しているか")) chunks = reply('{"type":"completed"}');
    else if (last.includes("<context-summary-request>")) chunks = reply("要約できません");
    else if (last.includes(`<${TASK_SWITCH_TAG}>`)) {
      calls.switches++;
      chunks = reply(script.taskSwitch ?? '{"task":"new"}');
    } else if (last.includes(`<${TASK_HANDOFF_UPDATE_TAG}>`)) {
      calls.updates++;
      chunks = reply(script.update ?? "変更なし");
    } else {
      calls.main.push(JSON.parse(JSON.stringify(params)));
      chunks = script.main[Math.min(main++, script.main.length - 1)] ?? reply("了解");
    }
    for (const chunk of chunks) yield chunk;
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

function securityConfig(allowedTools: string[]): SecurityConfig {
  return { allowedDirectories: [], blockedCommands: [], rules: { allow: [...allowedTools], deny: [], ask: [] } };
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

function makeLoop(provider: LLMProvider): { loop: AgentLoop; store: TaskHandoffStore } {
  const registry = makeRegistry();
  const loop = new AgentLoop(
    provider,
    "test-model-7b",
    registry,
    new PermissionManager(securityConfig(registry.getToolNames())),
    W,
  );
  const store = new TaskHandoffStore(dir);
  loop.enableTaskHandoff(store);
  return { loop, store };
}

const text = (t: string): ChatChunk[] => [
  { type: "text", text: t },
  { type: "done", finishReason: "stop", usage: { promptTokens: 1_000, completionTokens: 20 } },
];
const call = (id: string, file: string): ChatChunk[] => [
  {
    type: "tool_call",
    toolCall: { id, type: "function", function: { name: "probe", arguments: JSON.stringify({ file_path: file }) } },
  },
  { type: "done", finishReason: "tool_calls" },
];

function readDocs(): TaskHandoffDoc[] {
  const out: TaskHandoffDoc[] = [];
  for (const sub of fs.readdirSync(dir)) {
    for (const f of fs.readdirSync(path.join(dir, sub))) {
      if (f.endsWith(".json")) out.push(JSON.parse(fs.readFileSync(path.join(dir, sub, f), "utf8")));
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const CAT = "Blender で猫を作ってください。 尻尾は長め、 色は茶色で。";
const WOLF = "今度は Blender で狼を作ってください。";

describe("新しい依頼での畳み込み (§5)", () => {
  it("回帰 (2026-11-07): 要約 21 件と忘却の記録で埋まった猫の履歴に、 別の依頼 (狼) が来たら、 猫を文書に閉じて 1 行に畳み、 枠を大きく下回る", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const provider = scriptedProvider(
      {
        main: [text("狼を作ります。")],
        taskSwitch: '{"task":"new"}',
        update:
          "## 現状\n猫の胴体と頭まで作った\n## 試して駄目だった事\n+ 画像生成 — API キーが無い\n## 次の一手\n耳を付ける",
      },
      calls,
    );
    const { loop } = makeLoop(provider);
    // 2026-11-07 の最後の送信の形: 利用者の依頼、 全体を書き直した要約が 21 件、 大きな忘却の記録 (猫の依頼は中断で終わった)
    const messages: Message[] = [{ role: "user", content: CAT }];
    for (let i = 0; i < 21; i++) {
      messages.push({
        role: "assistant",
        content: `${SUMMARY_MESSAGE_OPEN}\n# Summary of the conversation so far\n${"猫の作業の要約。".repeat(520)}\n${SUMMARY_MESSAGE_CLOSE}`,
      });
      if (i % 5 === 0) messages.push({ role: "user", content: `(続けて ${i})` });
    }
    messages.push({ role: "system", content: `${TOMBSTONE_MARKER} 整理 r-25: ${"記録".repeat(3_000)}` });
    const session = createSession("test-model-7b");
    session.messages = messages;
    loop.restoreSession(session);
    const before = loop.getReductionStatus().promptSize.tokens;
    expect(before).toBeGreaterThan(90_000);

    const replaced = vi.spyOn(MessageHistory.prototype, "replaceMessages");
    await loop.run(WOLF);

    // 前のタスク (猫) は文書に閉じた: 依頼の原文はそのまま、 判断の節は LLM の更新、 状態は中断
    const docs = readDocs();
    expect(docs).toHaveLength(2);
    const [cat, wolf] = docs;
    expect(cat.status).toBe("中断");
    expect(cat.requests[0].text).toBe(CAT);
    expect(cat.current).toBe("猫の胴体と頭まで作った");
    expect(cat.failures).toEqual(["画像生成 — API キーが無い"]);
    expect(cat.archivedSessionId).toBeTruthy();
    expect(wolf.requests[0].text).toBe(WOLF);
    expect(wolf.status).toBe("進行中");
    expect(calls.switches).toBe(1);
    expect(calls.updates).toBe(1);

    // 履歴はポインタ 1 件 + 新しい依頼 + 応答。 最低量 F を見ずに畳んだ (書き換え理由 task-fold を申告)
    const raw = loop.getHistory().getRawMessages();
    expect(raw).toHaveLength(3);
    expect(isTaskPointerMessage(raw[0])).toBe(true);
    expect(String(raw[0].content)).toContain(`（中断）`);
    expect(String(raw[0].content)).toContain(path.join(dir, `${cat.sessionId}.tasks`, `${cat.id}.md`));
    expect(raw[1].content).toBe(WOLF);
    expect(replaced.mock.calls.map((c) => c[1])).toEqual([expect.stringMatching(/^task-fold:f-/)]);

    // 狼の最初の本体呼び出しは枠を大きく下回る
    expect(calls.main).toHaveLength(1);
    const sentTokens = estimateMessageTokens(calls.main[0].messages);
    expect(sentTokens).toBeLessThan(W * 0.1);
    expect(loop.getActiveTaskHandoffPaths()?.json).toBe(path.join(dir, `${wolf.sessionId}.tasks`, `${wolf.id}.json`));
  });

  it("依頼をまたいだ畳み込みは理由を申告するので、 予期しない前方の書き換え (unexpected) にならない。 正常に終わったタスクは完了で閉じる", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const provider = scriptedProvider(
      {
        main: [call("p1", "C:/work/cat.blend"), text("猫が出来ました。"), text("狼を作ります。")],
        taskSwitch: '{"task":"new"}',
        update: "## 現状\n猫が出来た",
      },
      calls,
    );
    const { loop } = makeLoop(provider);
    const breaks: Array<{ reasons: string[] }> = [];
    const realBreak = LLMLogger.prototype.logPrefixBreak;
    vi.spyOn(LLMLogger.prototype, "logPrefixBreak").mockImplementation(function (this: LLMLogger, info, reasons) {
      const unexpected = realBreak.call(this, info, reasons);
      if (info.previousTotal > 0 && info.messageOffset < info.previousTotal) breaks.push({ reasons: [...reasons] });
      expect(unexpected).toBe(false);
      return unexpected;
    });

    await loop.run(CAT);
    // 依頼の終わりで判断の節を直した (ツール呼び出しがあった)。 関係するファイルは引数から
    expect(calls.updates).toBe(1);
    let docs = readDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0].lastCheckpoint).toBe("request-end");
    expect(docs[0].files).toEqual(["C:/work/cat.blend"]);

    await loop.run(WOLF);
    docs = readDocs();
    expect(docs[0].status).toBe("完了");
    expect(breaks).toHaveLength(1);
    expect(breaks[0].reasons[0]).toMatch(/^task-fold:/);
    // 依頼の終わりで更新済みなので、 畳む前の更新は呼ばない (前回より後に増えた分が無い)
    expect(calls.updates).toBe(1);
  });

  it("続きの発言なら畳まず、 依頼の原文に追記する", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const provider = scriptedProvider(
      { main: [text("はい。"), text("長くしました。")], taskSwitch: '{"task":"new"}' },
      calls,
    );
    const { loop } = makeLoop(provider);
    await loop.run(CAT);
    await loop.run("もっと尻尾を長くして");
    const docs = readDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0].requests.map((r) => r.text)).toEqual([CAT, "もっと尻尾を長くして"]);
    expect(calls.switches).toBe(0);
    expect(loop.getHistory().getRawMessages().some(isTaskPointerMessage)).toBe(false);
  });

  it("続きか別かを決められなければ、 畳まずに続きとして扱う (履歴を消す側に倒さない)", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const provider = scriptedProvider({ main: [text("はい。")], taskSwitch: "わかりません" }, calls);
    const { loop } = makeLoop(provider);
    await loop.run(CAT);
    await loop.run(WOLF);
    expect(calls.switches).toBe(1);
    expect(readDocs()).toHaveLength(1);
    expect(loop.getHistory().getRawMessages().some(isTaskPointerMessage)).toBe(false);
  });

  it("前のタスクの判断の節を更新できなければ畳まない (前のタスクは閉じ、 新しいタスクの文書は作る)", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const provider = scriptedProvider(
      { main: [text("はい。")], taskSwitch: '{"task":"new"}', update: "形の違う出力" },
      calls,
    );
    const { loop } = makeLoop(provider);
    await loop.run(CAT);
    await loop.run(WOLF);
    // ツール呼び出しも 2,000 字も無いので依頼の終わりは更新しない。 畳む前の更新は 2 回求めて失敗
    expect(calls.updates).toBe(2);
    const docs = readDocs();
    expect(docs.map((d) => d.status)).toEqual(["完了", "進行中"]);
    const raw = loop.getHistory().getRawMessages();
    expect(raw.some(isTaskPointerMessage)).toBe(false);
    expect(raw[0].content).toBe(CAT);
  });
});

describe("整理の前の書き込み (§6)", () => {
  function sessionWithToolResults(): Message[] {
    const messages: Message[] = [{ role: "user", content: CAT }];
    for (let i = 0; i < 8; i++) {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{ id: `c${i}`, type: "function", function: { name: "probe", arguments: "{}" } }],
      });
      messages.push({ role: "tool", tool_call_id: `c${i}`, content: "y".repeat(8_000) });
    }
    messages.push({ role: "assistant", content: "途中まで出来ました。" });
    return messages;
  }

  it("差し替える前に文書を書く (判断の節も更新してから落とす)", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const provider = scriptedProvider({ main: [text("x")], update: "## 現状\n古い結果を消す前の状態" }, calls);
    const { loop } = makeLoop(provider);
    const session = createSession("test-model-7b");
    session.messages = sessionWithToolResults();
    loop.restoreSession(session);
    const order: string[] = [];
    const realReplace = MessageHistory.prototype.replaceMessages;
    vi.spyOn(MessageHistory.prototype, "replaceMessages").mockImplementation(function (
      this: MessageHistory,
      next,
      reason,
    ) {
      order.push(`replace:${String(reason).split(":")[0]}`);
      return realReplace.call(this, next, reason);
    });
    const realSave = TaskHandoffStore.prototype.save;
    vi.spyOn(TaskHandoffStore.prototype, "save").mockImplementation(function (this: TaskHandoffStore, doc) {
      order.push(`save:${doc.lastCheckpoint}`);
      return realSave.call(this, doc);
    });

    const result = await loop.runReductionEvent("manual");
    expect(result.ok).toBe(true);
    expect(calls.updates).toBe(1);
    expect(order).toEqual(["save:create", "save:before-reduction", "replace:reduction"]);
    expect(readDocs()[0].current).toBe("古い結果を消す前の状態");
    // 第 2 段 (§9): 要約は呼ばず、 書いた文書から抜き出した抜粋 1 件に置き換えた。 依頼の原文はそのまま抜粋に入る
    expect(result.record.taskExcerpt).toMatchObject({ status: "applied", counts: { userMessages: 1 } });
    const raw = loop.getHistory().getRawMessages();
    expect(raw.filter(isTaskHandoffExcerptMessage)).toHaveLength(1);
    expect(isTaskHandoffExcerptMessage(raw[0])).toBe(true);
    expect(String(raw[0].content)).toContain(`- ${CAT}`);
    expect(String(raw[0].content)).toContain("古い結果を消す前の状態");
  });

  it("文書を書けなければ履歴を書き換えない (task-handoff-failed)", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const provider = scriptedProvider({ main: [text("x")], update: "変更なし" }, calls);
    const { loop } = makeLoop(provider);
    const session = createSession("test-model-7b");
    session.messages = sessionWithToolResults();
    loop.restoreSession(session);
    const before = loop.getHistory().getRawMessages();
    vi.spyOn(TaskHandoffStore.prototype, "save").mockImplementation(() => {
      throw new Error("ディスクがいっぱい");
    });
    const result = await loop.runReductionEvent("manual");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("task-handoff-failed");
    expect(result.detail).toContain("ディスクがいっぱい");
    expect(loop.getHistory().getRawMessages()).toEqual(before);
  });
});

describe("整理で要約を抜粋に置き換える (§9。 第 2 段)", () => {
  it("回帰 (2026-11-07): 要約 21 件で埋まった長い 1 つのタスクを続けると、 整理 (再開の後の新しい依頼の区切り) で要約 21 件と忘却の記録が抜粋 1 件になり、 ポインタは先頭のまま、 次の呼び出しは枠を大きく下回る", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const main: ChatChunk[][] = [];
    for (let i = 0; i < 6; i++) main.push(call(`p${i}`, `C:/work/cat-${i}.py`));
    main.push(text("耳を付けました。"));
    const provider = scriptedProvider({ main, update: "## 現状\n胴体と頭まで作った\n## 次の一手\n耳を付ける" }, calls);
    const { loop } = makeLoop(provider);
    const pointer = buildTaskPointerMessage(["- 前の犬: C:/s/t-dog.md（完了）"]);
    const messages: Message[] = [
      { role: "user", content: pointer },
      { role: "user", content: CAT },
    ];
    for (let i = 0; i < 21; i++) {
      messages.push({
        role: "assistant",
        content: `${SUMMARY_MESSAGE_OPEN}\n# Summary of the conversation so far\n${"猫の作業の要約。".repeat(520)}\n${SUMMARY_MESSAGE_CLOSE}`,
      });
    }
    messages.push({ role: "system", content: `${TOMBSTONE_MARKER} 整理 r-25: ${"記録".repeat(3_000)}` });
    const session = createSession("test-model-7b");
    session.messages = messages;
    loop.restoreSession(session);
    const records: ReductionEventRecord[] = [];
    const realLog = LLMLogger.prototype.logReductionEvent;
    vi.spyOn(LLMLogger.prototype, "logReductionEvent").mockImplementation(function (this: LLMLogger, record) {
      records.push(record);
      return realLog.call(this, record);
    });

    await loop.run("続けて、 耳を付けて");

    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0].taskExcerpt).toMatchObject({ status: "applied", counts: { summaries: 21, forgetNotes: 1 } });
    expect(records[0].promptTokensAfter).toBeLessThan(W * 0.2);
    const raw = loop.getHistory().getRawMessages();
    expect(raw[0].content).toBe(pointer);
    expect(raw.filter(isTaskHandoffExcerptMessage)).toHaveLength(1);
    const excerpt = String(raw.find(isTaskHandoffExcerptMessage)?.content);
    expect(excerpt).toContain(`- ${CAT}`);
    expect(excerpt).toContain("- (追加) 続けて、 耳を付けて");
    expect(excerpt).toContain("胴体と頭まで作った");
    expect(raw.some((m) => String(m.content).startsWith(SUMMARY_MESSAGE_OPEN))).toBe(false);
    // 整理の後の本体呼び出しは小さい
    expect(estimateMessageTokens(calls.main.at(-1)?.messages ?? [])).toBeLessThan(W * 0.3);
  });

  it("判断の節を直せなければ抜粋を使わず要約の動作にし、 記録 (reduction_event) と /context の直近の整理に出す", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const provider = scriptedProvider({ main: [text("x")], update: "形の違う出力" }, calls);
    const { loop } = makeLoop(provider);
    const messages: Message[] = [{ role: "user", content: CAT }];
    for (let i = 0; i < 4; i++) {
      messages.push({
        role: "assistant",
        content: `${SUMMARY_MESSAGE_OPEN}\n${"要約。".repeat(800)}\n${SUMMARY_MESSAGE_CLOSE}`,
      });
    }
    for (let i = 0; i < 8; i++) {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{ id: `c${i}`, type: "function", function: { name: "probe", arguments: "{}" } }],
      });
      messages.push({ role: "tool", tool_call_id: `c${i}`, content: "y".repeat(8_000) });
    }
    messages.push({ role: "assistant", content: "途中まで出来ました。" });
    const session = createSession("test-model-7b");
    session.messages = messages;
    loop.restoreSession(session);
    const logged: unknown[] = [];
    vi.spyOn(LLMLogger.prototype, "logReductionEvent").mockImplementation((record) => {
      logged.push(record);
    });
    const result = await loop.runReductionEvent("manual");
    expect(result.ok).toBe(true);
    expect(result.record.taskExcerpt).toMatchObject({ status: "fallback", reason: "refine-failed" });
    expect(logged).toEqual([
      expect.objectContaining({ taskExcerpt: expect.objectContaining({ reason: "refine-failed" }) }),
    ]);
    const last = loop.getLastReductionEvent();
    expect(last && "record" in last ? last.record.taskExcerpt.status : null).toBe("fallback");
    expect(loop.getHistory().getRawMessages().some(isTaskHandoffExcerptMessage)).toBe(false);
  });
});

describe("/handoff と再開 (§7・§4.1)", () => {
  it("/handoff dry は文書から描き、 依頼の原文がそのまま入る", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const provider = scriptedProvider(
      { main: [text("はい。")], update: "## 決まり・制約\n+ Blender 4.2 を使う\n## 次の一手\n耳を付ける" },
      calls,
    );
    const { loop } = makeLoop(provider);
    await loop.run(CAT);
    const preview = await loop.buildHandoffPreview();
    expect(preview.note).toContain(`> ${CAT}`);
    expect(preview.note).toContain("- Blender 4.2 を使う");
    expect(preview.note).toContain("- 耳を付ける");
    expect(preview.note).toContain("このタスクの引き継ぎ文書 (正本)");
    expect(readDocs()[0].lastCheckpoint).toBe("handoff");
  });

  it("/handoff from-file は利用者のファイルの決まりを文書に写すだけ (正本にはしない)", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const { loop } = makeLoop(scriptedProvider({ main: [text("はい。")] }, calls));
    await loop.run(CAT);
    const result = await loop.runHandoffNow("## 守るべき制約・決定事項\n- 色は白にする\n\n## 次にやること\n- 耳");
    expect(result.applied).toBe(true);
    const doc = readDocs()[0];
    expect(doc.constraints).toEqual(["色は白にする"]);
    expect(doc.requests[0].text).toBe(CAT);
  });

  it("使っている文書のパスをセッションに保存し、 再開で読み戻す。 読めなければ警告して作り直す", async () => {
    const calls: Calls = { main: [], updates: 0, switches: 0 };
    const { loop } = makeLoop(scriptedProvider({ main: [text("はい。")] }, calls));
    await loop.run(CAT);
    loop.saveCurrentSession();
    const { saveSession } = await import("../../src/agent/session-manager.js");
    const saved = vi.mocked(saveSession).mock.calls.at(-1)?.[0];
    const activePath = loop.getActiveTaskHandoffPaths()?.json;
    expect(saved?.taskHandoff?.activeDocPath).toBe(activePath);

    const { loop: loop2 } = makeLoop(scriptedProvider({ main: [text("はい。")] }, calls));
    loop2.restoreSession(structuredClone(saved!));
    expect(loop2.getActiveTaskHandoffPaths()?.json).toBe(activePath);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = structuredClone(saved!);
    broken.taskHandoff = { activeDocPath: path.join(dir, "missing.json") };
    const { loop: loop3 } = makeLoop(scriptedProvider({ main: [text("はい。")] }, calls));
    loop3.restoreSession(broken);
    expect(loop3.getActiveTaskHandoffPaths()).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("タスクの引き継ぎ文書を読めませんでした");
  });
});
