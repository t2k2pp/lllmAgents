import { afterEach, describe, expect, it } from "vitest";
import { CacheMissCauseCollector } from "../../src/agent/cache-miss.js";
import { computeContextBudget, RequestGrowthTracker } from "../../src/agent/context-budget.js";
import { findToolPairingError, MessageHistory } from "../../src/agent/message-history.js";
import {
  applyTaskExcerpt,
  capForgetDigest,
  EXCERPT_FORGET_LINES_KEPT,
  planTaskExcerpt,
  renderExcerptMessage,
} from "../../src/agent/reduction-excerpt.js";
import {
  type ReductionEventInput,
  type ReductionEventRecord,
  buildReductionTombstoneText,
  runReductionEvent,
} from "../../src/agent/reduction-event.js";
import {
  capTombstoneBlocks,
  estimateSentMessageTokens,
  TOMBSTONE_BLOCKS_KEPT,
  TOMBSTONE_MARKER,
} from "../../src/agent/reduction-stages.js";
import {
  isReductionSummaryMessage,
  type MainCallRequest,
  SUMMARY_HEADINGS,
  SUMMARY_MESSAGE_CLOSE,
  SUMMARY_MESSAGE_OPEN,
} from "../../src/agent/reduction-summary.js";
import { setSideCallSink } from "../../src/agent/side-call.js";
import {
  buildTaskPointerMessage,
  createTaskHandoffDoc,
  isTaskHandoffExcerptMessage,
  isTaskPointerMessage,
  renderTaskHandoffExcerpt,
  type TaskHandoffDoc,
} from "../../src/agent/task-handoff.js";
import type {
  ChatChunk,
  ChatWithToolsParams,
  LLMProvider,
  Message,
  ToolCall,
} from "../../src/providers/base-provider.js";

/** 第 2 段: 整理の段階 3 を引き継ぎ文書の抜粋に置き換える (docs/task-handoff-design.md §9) */

afterEach(() => {
  setSideCallSink(undefined);
});

let idSeq = 0;
function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `c${++idSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function batch(c: ToolCall, result: string): Message[] {
  return [
    { role: "assistant", content: "", tool_calls: [c] },
    { role: "tool", content: result, tool_call_id: c.id },
  ];
}
const user = (content: string): Message => ({ role: "user", content });
const reply = (content: string): Message => ({ role: "assistant", content });
const BIG = "a".repeat(8000); // 約 2,200 トークン
const read = (p: string): Message[] => batch(call("file_read", { file_path: p }), BIG);

const CAT = "Blender で猫を作ってください。 尻尾は長め、 色は茶色で。";
const POINTER = user(buildTaskPointerMessage(["- 前の犬: C:/s/t-dog.md（完了）"]));
const summaryMessage = (i: number): Message =>
  reply(
    `${SUMMARY_MESSAGE_OPEN}\n# Summary of the conversation so far\n${`猫の作業の要約 ${i}。`.repeat(400)}\n${SUMMARY_MESSAGE_CLOSE}`,
  );

function docOf(requests: string[], current = "胴体まで"): TaskHandoffDoc {
  const doc = createTaskHandoffDoc({ sessionId: "s", requests: requests.map((text) => ({ text })), id: "t-cat" });
  doc.current = current;
  doc.next = "耳を付ける";
  doc.constraints = ["色は茶色"];
  return doc;
}

// ─── 純粋な部分 ───

describe("抜粋の範囲 (planTaskExcerpt)", () => {
  it("ポインタの後ろから保護部分の手前まで: 要約・前の抜粋・忘却の記録・文書にある利用者の発言・やり取りを落とし、 文書に無い発言・画像・ask_user・ポインタは残す", () => {
    const doc = docOf([CAT, "尻尾をもっと長く"]);
    const prevExcerpt = user(
      renderTaskHandoffExcerpt(docOf([CAT]), "C:/t.md", undefined, { lines: ["- 古い行"], omitted: 3 }),
    );
    const ask = call("ask_user", { question: "色は?" });
    const image: Message = {
      role: "user",
      content: [
        { type: "text", text: CAT },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    };
    const messages: Message[] = [
      POINTER,
      user(CAT),
      summaryMessage(1),
      prevExcerpt,
      { role: "system", content: buildReductionTombstoneText("r-1", ["- 古い結果: file_read 2 回"]) },
      user("尻尾をもっと長く"),
      user("ついでに耳は三角で"),
      image,
      { role: "user", content: "続きを出力してください", ephemeral: true },
      ...batch(ask, "茶色"),
      ...read("/a"),
      reply("途中"),
      ...read("/b"),
      reply("最新"),
    ];
    const plan = planTaskExcerpt(messages, 1, doc, ["- 今回の行"]);
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.start).toBe(1);
    // 保護部分は直近 1 回のツール呼び出し (/b) から
    expect(messages[plan.end].tool_calls?.[0].function.arguments).toContain("/b");
    expect(plan.counts).toEqual({
      summaries: 1,
      excerpts: 1,
      forgetNotes: 1,
      userMessages: 2,
      otherMessages: 4,
      keptMessages: 4,
    });
    // 忘却の記録: 前の抜粋 (省略 3 + 1 行)、 範囲の記録、 今回の行の順
    expect(plan.forget).toEqual({ lines: ["- 古い行", "- 古い結果: file_read 2 回", "- 今回の行"], omitted: 3 });

    const out = applyTaskExcerpt(messages, plan, renderExcerptMessage(doc, "C:/t.md", plan));
    expect(findToolPairingError(out)).toBeNull();
    expect(isTaskPointerMessage(out[0])).toBe(true);
    expect(isTaskHandoffExcerptMessage(out[1])).toBe(true);
    expect(out.filter(isTaskHandoffExcerptMessage)).toHaveLength(1);
    expect(out.some(isReductionSummaryMessage)).toBe(false);
    expect(out.some((m) => m.role === "system")).toBe(false);
    // 文書に無い発言・画像付き・ask_user の組は原文のまま残る
    expect(out.map((m) => (typeof m.content === "string" ? m.content : "[parts]"))).toEqual([
      POINTER.content,
      expect.stringContaining(CAT),
      "ついでに耳は三角で",
      "[parts]",
      "",
      "茶色",
      "",
      BIG,
      "最新",
    ]);
    // 依頼の原文はそのまま抜粋に入る
    expect(String(out[1].content)).toContain(`- ${CAT}`);
    expect(String(out[1].content)).toContain("- (追加) 尻尾をもっと長く");
  });

  it("ツール呼び出しの無い履歴で保護部分の頭が要約・忘却の記録なら、 それも範囲に入れる (2026-11-07 の形)", () => {
    const messages: Message[] = [
      user(CAT),
      summaryMessage(1),
      summaryMessage(2),
      { role: "system", content: buildReductionTombstoneText("r-1", ["- 行"]) },
      user("ついでに"),
    ];
    const plan = planTaskExcerpt(messages, 2, docOf([CAT]), []);
    expect(plan?.end).toBe(4);
    expect(plan?.counts).toMatchObject({ summaries: 2, forgetNotes: 1, userMessages: 1 });
  });

  it("落とすものが無ければ null", () => {
    expect(planTaskExcerpt([POINTER, user("ついでに"), ...read("/a"), reply("x")], 1, docOf([CAT]), [])).toBeNull();
  });

  it("忘却の記録は直近の行だけにし、 省いた数を足していく", () => {
    const lines = Array.from({ length: EXCERPT_FORGET_LINES_KEPT + 5 }, (_, i) => `- 行 ${i}`);
    const d = capForgetDigest({ lines, omitted: 7 });
    expect(d.lines).toHaveLength(EXCERPT_FORGET_LINES_KEPT);
    expect(d.lines.at(-1)).toBe(`- 行 ${EXCERPT_FORGET_LINES_KEPT + 4}`);
    expect(d.omitted).toBe(12);
  });
});

describe("忘却の記録の上限 (capTombstoneBlocks)", () => {
  it("直近の整理の回だけ残し、 それより前は回数だけにする (何度追記しても伸び続けない)", () => {
    let content = buildReductionTombstoneText("r-0", ["- 行"]);
    for (let i = 1; i <= 30; i++)
      content = capTombstoneBlocks(`${content}\n\n${buildReductionTombstoneText(`r-${i}`, ["- 行"])}`);
    const blocks = content.split(`\n\n${TOMBSTONE_MARKER}`);
    expect(blocks).toHaveLength(TOMBSTONE_BLOCKS_KEPT + 1);
    expect(content.startsWith(`${TOMBSTONE_MARKER} それより前の整理 ${31 - TOMBSTONE_BLOCKS_KEPT} 回分`)).toBe(true);
    expect(content).toContain("整理 r-30");
    expect(content).not.toContain("整理 r-26:");
  });
});

describe("抜粋の描き方 (renderTaskHandoffExcerpt)", () => {
  it("依頼の原文は最初の依頼と新しい追加を優先し、 途中の古い追加は件数だけにする", () => {
    const doc = docOf([CAT, "い".repeat(3_000), "う".repeat(3_000), "え".repeat(3_000), "最新の追加"]);
    const text = renderTaskHandoffExcerpt(doc, "C:/t.md", 3_100);
    expect(text).toContain(`- ${CAT}`);
    expect(text).toContain("- (追加) 最新の追加");
    expect(text).toContain("(続きは文書)");
    expect(text).toContain("- (ほか 1 件の追加は文書の全文を読む)");
    // 描くのは元の順
    expect(text.indexOf(CAT)).toBeLessThan(text.indexOf("最新の追加"));
  });
});

// ─── 整理イベント ───

function summaryOutput(instruction: string): string {
  const n = Number(/for each of the (\d+) segments/.exec(instruction)?.[1] ?? "0");
  const segs = Array.from({ length: n }, (_, i) => `<segment n="${i + 1}">区間 ${i + 1}</segment>`);
  const body = SUMMARY_HEADINGS.map((h) => `## ${h}\n${"これまでの猫の作業。".repeat(60)}`);
  return `${segs.join("\n")}\n<summary>\n${body.join("\n\n")}\n</summary>`;
}

function summaryProvider(sent: ChatWithToolsParams[]): LLMProvider {
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    sent.push(params);
    yield { type: "text", text: summaryOutput(String(params.messages.at(-1)?.content ?? "")) };
    yield { type: "done", finishReason: "stop" };
  };
  return { providerType: "llamacpp", chat: chatWithTools, chatWithTools } as unknown as LLMProvider;
}

const W = 131_072;
const budget = computeContextBudget(W, "T2");
const TOOLS: ChatWithToolsParams["tools"] = [
  { type: "function", function: { name: "file_read", description: "read", parameters: { type: "object" } } },
];

function historyWith(messages: Message[]): MessageHistory {
  const h = new MessageHistory("SYSTEM");
  h.replaceMessages(messages);
  h.takeRewriteReasons();
  return h;
}

function mainRequest(history: MessageHistory): MainCallRequest {
  return {
    method: "chatWithTools",
    params: { model: "m", messages: history.getMessages(), tools: TOOLS, stream: true, maxTokens: 8_192 },
  };
}

function promptOf(history: MessageHistory): number {
  return estimateSentMessageTokens(history.getRawMessages()) + 200;
}

/** 文書の正本の代わり (beforeRewrite が書いて返す)。 依頼の原文は利用者の発言から追記する */
class FakeDocStore {
  doc: TaskHandoffDoc;
  writes = 0;
  refineFails = false;
  constructor(requests: string[]) {
    this.doc = docOf(requests);
  }
  hooks(): Pick<ReductionEventInput, "beforeRewrite" | "taskExcerpt"> {
    return {
      beforeRewrite: async () => {
        this.writes++;
        this.doc = { ...this.doc, current: `整理 ${this.writes} 回目の前の現状` };
        return this.refineFails ? null : this.doc;
      },
      taskExcerpt: { peek: () => this.doc, mdPathOf: () => "C:/s/s.tasks/t-cat.md" },
    };
  }
}

function eventInput(
  history: MessageHistory,
  id: string,
  trigger: ReductionEventInput["trigger"],
  extra: Partial<ReductionEventInput>,
  sent: ChatWithToolsParams[],
): ReductionEventInput {
  return {
    id,
    trigger,
    history,
    provider: summaryProvider(sent),
    budget,
    keepRecentToolUses: 2,
    promptSize: { tokens: promptOf(history), basis: "estimate" },
    growthTokens: 8_000,
    currentRequestStart: 0,
    buildMainCallRequest: () => mainRequest(history),
    cacheMissCauses: new CacheMissCauseCollector(),
    growth: new RequestGrowthTracker(),
    caseInsensitivePaths: true,
    summaryFailure: "continue",
    ...extra,
  };
}

/** 2026-11-07 の最後の送信の形: ポインタ、 依頼、 全体を書き直した要約が 21 件、 大きな忘却の記録 */
function catHistory(): Message[] {
  const messages: Message[] = [POINTER, user(CAT)];
  for (let i = 0; i < 21; i++) {
    messages.push(summaryMessage(i));
    if (i % 5 === 0) messages.push(user(`(続けて ${i})`));
  }
  messages.push({ role: "system", content: `${TOMBSTONE_MARKER} 整理 r-25: ${"記録".repeat(3_000)}` });
  return messages;
}

/** 長い 1 つのタスクを模す: 1 回ごとにツール結果と発言を足して整理する。 整理の後の P を返す */
async function simulate(
  rounds: number,
  trigger: "forced" | "manual",
  store: FakeDocStore | null,
  sent: ChatWithToolsParams[],
): Promise<{ records: ReductionEventRecord[]; history: MessageHistory }> {
  const history = historyWith(catHistory());
  const records: ReductionEventRecord[] = [];
  for (let round = 0; round < rounds; round++) {
    const added: Message[] = [];
    if (round % 4 === 3) {
      const text = `(続けて ${round}) 尻尾の先を白に`;
      added.push(user(text));
      if (store) store.doc = { ...store.doc, requests: [...store.doc.requests, { at: "", text, kind: "follow-up" }] };
    }
    for (let k = 0; k < 14; k++) added.push(...read(`C:/work/cat-${round}-${k}.py`));
    added.push(reply(`${"猫の形を整えています。".repeat(800)} (${round})`));
    history.replaceMessages([...history.getRawMessages(), ...added]);
    history.takeRewriteReasons();
    const result = await runReductionEvent(
      eventInput(history, `r-${round}`, trigger, store ? store.hooks() : {}, sent),
    );
    expect(result.ok, result.ok ? "" : result.detail).toBe(true);
    records.push(result.record);
    // 抜粋の道: 抜粋は 1 件だけ、 ポインタは先頭、 依頼の原文はそのまま
    if (store && result.record.taskExcerpt.status === "applied") {
      const raw = history.getRawMessages();
      expect(isTaskPointerMessage(raw[0])).toBe(true);
      expect(raw.filter(isTaskHandoffExcerptMessage)).toHaveLength(1);
      expect(isTaskHandoffExcerptMessage(raw[1])).toBe(true);
      expect(String(raw[1].content)).toContain(`- ${CAT}`);
      expect(String(raw[1].content)).toContain(`整理 ${store.writes} 回目の前の現状`);
      expect(raw.some(isReductionSummaryMessage)).toBe(false);
      expect(raw.filter((m) => m.role === "system").length).toBeLessThanOrEqual(1);
      expect(findToolPairingError(raw)).toBeNull();
    }
  }
  return { records, history };
}

describe("回帰 (2026-11-07): 長い 1 つのタスクで整理を何度も繰り返す", () => {
  it("手動の整理を 21 回: 毎回文書から抜き出し直した抜粋 1 件になり、 整理の後の P は上がり続けない (枠の 2 割未満で一定)", async () => {
    const store = new FakeDocStore([CAT, "(続けて 0)", "(続けて 5)", "(続けて 10)", "(続けて 15)", "(続けて 20)"]);
    const sent: ChatWithToolsParams[] = [];
    const { records } = await simulate(21, "manual", store, sent);
    expect(records.every((r) => r.taskExcerpt.status === "applied")).toBe(true);
    // 要約は 1 度も呼ばない (文書の更新が要約の代わり)
    expect(sent).toHaveLength(0);
    expect(store.writes).toBe(21);
    const after = records.map((r) => r.promptTokensAfter);
    expect(Math.max(...after)).toBeLessThan(W * 0.2);
    expect(Math.max(...after) - Math.min(...after)).toBeLessThan(4_000);
    // 最初の整理で要約 21 件・忘却の記録・文書にある発言を外した
    const first = records[0].taskExcerpt;
    expect(first.status === "applied" && first.counts).toMatchObject({
      summaries: 21,
      forgetNotes: 1,
      userMessages: 6,
    });
  });

  it("規則 1 (入らない) で 21 回: 止まらず (still-too-large にならず)、 整理の後の P は目標を下回り、 上がり続けない", async () => {
    const store = new FakeDocStore([CAT, "(続けて 0)", "(続けて 5)", "(続けて 10)", "(続けて 15)", "(続けて 20)"]);
    const sent: ChatWithToolsParams[] = [];
    const { records } = await simulate(21, "forced", store, sent);
    expect(records.some((r) => r.taskExcerpt.status === "applied")).toBe(true);
    const after = records.map((r) => r.promptTokensAfter);
    for (const r of records) expect(r.promptTokensAfter).toBeLessThanOrEqual(r.targetPromptTokens);
    // 抜粋の大きさは文書の節の上限で決まる (依頼の原文の追加が増えても抜粋では 6,000 字まで)
    expect(Math.max(...after)).toBeLessThan(W * 0.2);
    expect(Math.max(...after) - Math.min(...after)).toBeLessThan(4_000);
  });

  it("比べ: 文書が無い (今までの要約の動作) と、 要約 21 件と忘却の記録が残ったまま整理の後の P が上がり続ける", async () => {
    const sent: ChatWithToolsParams[] = [];
    const { records, history } = await simulate(6, "manual", null, sent);
    expect(records.every((r) => r.taskExcerpt.status === "not-used")).toBe(true);
    expect(history.getRawMessages().filter(isReductionSummaryMessage).length).toBeGreaterThanOrEqual(21);
    const after = records.map((r) => r.promptTokensAfter);
    expect(after.every((v, i) => i === 0 || v > after[i - 1])).toBe(true);
    expect(after.at(-1)).toBeGreaterThan(W);
  });
});

describe("文書が使えないときは今までの要約の動作 (記録に出す)", () => {
  function heavy(): Message[] {
    const out: Message[] = [user(CAT)];
    for (let i = 0; i < 4; i++) out.push(summaryMessage(i));
    out.push(reply("猫の形を整えています。".repeat(1_200)));
    for (let i = 0; i < 6; i++) out.push(...read(`/f${i}`));
    out.push(reply("途中"));
    return out;
  }

  it("文書が無い (peek が null): 要約で整理し、 taskExcerpt は fallback / no-doc。 文書は書かない口でも差し替え前に呼ぶ", async () => {
    const history = historyWith(heavy());
    const sent: ChatWithToolsParams[] = [];
    let wrote = 0;
    const result = await runReductionEvent(
      eventInput(
        history,
        "r-x",
        "manual",
        {
          beforeRewrite: async () => {
            wrote++;
            return null;
          },
          taskExcerpt: { peek: () => null, mdPathOf: () => "" },
        },
        sent,
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.record.taskExcerpt).toMatchObject({ status: "fallback", reason: "no-doc" });
    expect(result.record.summary.status).toBe("done");
    expect(sent).toHaveLength(1);
    expect(wrote).toBe(1);
    expect(history.getRawMessages().some(isTaskHandoffExcerptMessage)).toBe(false);
  });

  it("判断の節を直せなかった (beforeRewrite が null): 古い現状の抜粋で落とさず要約に切り替え、 fallback / refine-failed", async () => {
    const history = historyWith(heavy());
    const store = new FakeDocStore([CAT]);
    store.refineFails = true;
    const sent: ChatWithToolsParams[] = [];
    const result = await runReductionEvent(eventInput(history, "r-y", "manual", store.hooks(), sent));
    expect(result.ok).toBe(true);
    expect(result.record.taskExcerpt).toMatchObject({ status: "fallback", reason: "refine-failed" });
    expect(result.record.summary.status).toBe("done");
    expect(store.writes).toBe(1);
    expect(history.getRawMessages().some(isTaskHandoffExcerptMessage)).toBe(false);
  });

  it("文書を書けなければ (beforeRewrite が投げる) 抜粋の道でも履歴は元のまま (task-handoff-failed)", async () => {
    const history = historyWith(heavy());
    const before = history.getRawMessages();
    const result = await runReductionEvent(
      eventInput(
        history,
        "r-z",
        "manual",
        {
          beforeRewrite: async () => {
            throw new Error("ディスクがいっぱい");
          },
          taskExcerpt: { peek: () => docOf([CAT]), mdPathOf: () => "" },
        },
        [],
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("task-handoff-failed");
    expect(history.getRawMessages()).toEqual(before);
  });
});
