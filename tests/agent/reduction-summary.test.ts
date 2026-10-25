import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { computeContextBudget } from "../../src/agent/context-budget.js";
import { MessageHistory, findToolPairingError } from "../../src/agent/message-history.js";
import { applyReductionStages } from "../../src/agent/reduction-stages.js";
import {
  ESTIMATED_OVERALL_SUMMARY_TOKENS,
  MIN_SUMMARY_OUTPUT_TOKENS,
  RECENT_FILES_LISTED,
  SUMMARY_HEADINGS,
  SUMMARY_MESSAGE_OPEN,
  type MainCallRequest,
  type ParsedSummary,
  type SummaryRange,
  applySummaryToCopy,
  buildStateHandover,
  collectRecentFiles,
  isReductionSummaryMessage,
  parseSummaryOutput,
  requestSummary,
  selectSummaryRange,
} from "../../src/agent/reduction-summary.js";
import { setSideCallSink, type SideCallRecord } from "../../src/agent/side-call.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type {
  ChatChunk,
  ChatParams,
  ChatWithToolsParams,
  LLMProvider,
  Message,
  ToolCall,
} from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { clearTodos } from "../../src/tools/definitions/todo-write.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

/** 段階 3: 要約の範囲・呼び出し・当てはめ・状態の渡し直し (docs/context-reduction-redesign.md §5.6 / §5.8) */

vi.mock("../../src/agent/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/session-manager.js")>();
  return { ...actual, saveSession: vi.fn() };
});

afterEach(() => {
  setSideCallSink(undefined);
  clearTodos();
});

// ─── テスト用の道具 ───

let idSeq = 0;
function call(name: string, args: Record<string, unknown> = {}, id = `c${++idSeq}`): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function batch(...pairs: Array<[ToolCall, string]>): Message[] {
  return [
    { role: "assistant", content: "", tool_calls: pairs.map(([c]) => c) },
    ...pairs.map(([c, result]) => ({ role: "tool" as const, content: result, tool_call_id: c.id })),
  ];
}
const user = (content: string): Message => ({ role: "user", content });
const reply = (content: string): Message => ({ role: "assistant", content });
const BIG = "a".repeat(8000); // 約 2,200 トークン

function read(path: string): Message[] {
  return batch([call("file_read", { file_path: path }), BIG]);
}

/** 段階 0〜2 を通さない写し (元の履歴と 1 対 1) で範囲を決める */
function rangeOf(messages: Message[], required: number, opts: { keep?: number } = {}) {
  return selectSummaryRange({
    messages,
    originalIndices: messages.map((_, i) => i),
    originalLength: messages.length,
    keepRecentToolUses: opts.keep ?? 1,
    shortfall: { toTarget: required, toMinimum: 0 },
  });
}

function okRange(result: ReturnType<typeof selectSummaryRange>): SummaryRange {
  if (!result.ok) throw new Error(`範囲が取れませんでした: ${result.detail}`);
  return result.range;
}

function validOutput(segmentCount: number, currentWork = "src/app.ts の parse() を直している途中"): string {
  const segs = Array.from({ length: segmentCount }, (_, i) => `<segment n="${i + 1}">区間 ${i + 1} の要約</segment>`);
  const body = SUMMARY_HEADINGS.map((h) =>
    h === "Current work" ? `## ${h}\n${currentWork}` : `## ${h}\n${h} の中身`,
  ).join("\n\n");
  return `${segs.join("\n")}\n<summary>\n${body}\n</summary>`;
}

function parsed(segmentCount: number): ParsedSummary {
  const r = parseSummaryOutput(validOutput(segmentCount), segmentCount);
  if (!r.ok) throw new Error(r.problems.join(", "));
  return r.summary;
}

interface RecordedRequest {
  method: string;
  params: ChatWithToolsParams;
}

/** 台本どおりに返す provider。 送った内容は送った瞬間の写しで残す */
function scriptedProvider(replies: ChatChunk[][], requests: RecordedRequest[]): LLMProvider {
  let n = 0;
  const make = (method: string) =>
    async function* (params: ChatParams): AsyncGenerator<ChatChunk> {
      requests.push({ method, params: JSON.parse(JSON.stringify(params)) });
      const script = replies[n++];
      if (!script) throw new Error(`台本の外の呼び出しです (${n} 回目)`);
      for (const chunk of script) yield chunk;
    };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: make("chat"),
    chatWithTools: make("chatWithTools"),
    supportsVision: async () => false,
    chatWithVision: make("chatWithVision"),
  } as unknown as LLMProvider;
}

const textChunks = (text: string, finishReason = "stop"): ChatChunk[] => [
  { type: "text", text },
  { type: "done", finishReason, usage: { promptTokens: 1000, completionTokens: 100 } },
];
const toolCallChunks = (id: string, name: string, args: Record<string, unknown> = { tag: id }): ChatChunk[] => [
  { type: "tool_call", toolCall: { id, type: "function", function: { name, arguments: JSON.stringify(args) } } },
  { type: "done", finishReason: "tool_calls" },
];

// ─── 1. 範囲 ───

describe("selectSummaryRange (要約の範囲)", () => {
  it("足りない量を満たす最小の範囲を選び、 終わりはツールの対を分けない", () => {
    const messages = [
      user("U1"),
      ...read("/a"),
      ...read("/b"),
      user("U2"),
      ...read("/c"),
      ...read("/d"),
      ...read("/e"),
    ];
    // 1 件 (約 2,200) では見込みの要約の大きさを引くと足りず、 2 件目の組の終わりで足りる
    const range = okRange(rangeOf(messages, 100));
    expect(range.start).toBe(0); // 履歴の先頭から (U1 は原文のまま残る)
    expect(range.segments.map((s) => [s.start, s.end])).toEqual([[1, 5]]);
    expect(range.end).toBe(5); // /a と /b の 2 組 (U2 の手前)
    expect(range.meetsShortfall).toBe(true);
    expect(range.segments).toHaveLength(1);
    expect(messages[range.end].role).not.toBe("tool");

    // もっと要るときは U2 をまたいで次の区間まで広げる。 区間は利用者の発言で分かれる
    const wider = okRange(rangeOf(messages, 2000));
    expect(wider.end).toBe(8);
    expect(wider.segments.map((s) => [s.start, s.end])).toEqual([
      [1, 5],
      [6, 8],
    ]);
    // 直近 K=1 回 (/e) は範囲に入らない
    expect(wider.end).toBeLessThanOrEqual(messages.length - 2);
  });

  it("最大まで広げても見込みで足りなければ、 最大の範囲を meetsShortfall=false で返す", () => {
    const messages = [user("U1"), ...read("/a"), ...read("/b"), ...read("/c")];
    const range = okRange(rangeOf(messages, 1_000_000));
    expect(range.meetsShortfall).toBe(false);
    expect(range.end).toBe(5); // 最新の 1 組 (/c) の手前まで
    expect(range.estimatedFreedTokens).toBeGreaterThan(0);
  });

  it("要らないとき・要約しても減らないときは ok=false", () => {
    const messages = [user("U1"), ...read("/a"), ...read("/b")];
    expect(rangeOf(messages, 0)).toMatchObject({ ok: false, reason: "not-needed" });
    const small = [user("U1"), ...batch([call("bash", { command: "ls" }), "x"]), ...read("/b")];
    expect(rangeOf(small, 100)).toMatchObject({ ok: false, reason: "nothing-to-summarize" });
  });

  it("既存の要約があればその次から始める (要約の要約をしない)", () => {
    const earlier = reply(`${SUMMARY_MESSAGE_OPEN}\n前の要約\n</summary-of-earlier-turns>`);
    const messages = [user("U1"), earlier, user("U2"), ...read("/a"), ...read("/b"), ...read("/c")];
    const range = okRange(rangeOf(messages, 100));
    expect(range.start).toBe(2);
    expect(range.originalStart).toBe(2);
  });

  it("利用者の発言・system ノート・保護するツールの組は区間を分け、 揮発の促しは区間に入る", () => {
    const nudge: Message = { ...user("(ハーネスの促し)"), ephemeral: true };
    const messages = [
      user("U1"),
      ...read("/a"),
      nudge,
      ...read("/b"),
      ...batch([call("ask_user", { question: "どちら?" }), "A にして"]),
      ...read("/c"),
      { role: "system", content: "[忘却の記録]" } as Message,
      ...read("/d"),
      ...read("/e"),
    ];
    const range = okRange(rangeOf(messages, 100_000));
    // [/a, 促し, /b] | ask_user は残す | [/c] | system | [/d]
    expect(range.segments.map((s) => [s.start, s.end])).toEqual([
      [1, 6],
      [8, 10],
      [11, 13],
    ]);
  });

  it("段階 0〜2 で消えたメッセージがあっても、 元の履歴の位置に対応させる", () => {
    const nudge: Message = { ...user("(前の依頼の促し)"), ephemeral: true };
    // 段階 1 がツール結果の本文を消すので、 大きいのはモデルの発言にする
    const raw = [user("U1"), reply(BIG), nudge, reply(BIG), user("U2"), reply(BIG), ...read("/d")];
    const stages = applyReductionStages({
      messages: raw,
      currentRequestStart: 4, // U2 から今の依頼
      keepRecentToolUses: 1,
      promptTokens: 100_000,
      goal: { targetPromptTokens: 0, minimumReductionTokens: 0 },
    });
    expect(stages.messages).toHaveLength(raw.length - 1); // 促しが消えた
    const range = okRange(
      selectSummaryRange({
        messages: stages.messages,
        originalIndices: stages.originalIndices,
        originalLength: raw.length,
        keepRecentToolUses: 1,
        shortfall: { toTarget: 0, toMinimum: 50_000 },
      }),
    );
    // 写しでは U2 の後の発言まで。 元の履歴では /d の組の先頭 (添字 6) の手前まで
    expect(range.end).toBe(5);
    expect(range.originalEnd).toBe(6);
    expect(raw[range.originalEnd].tool_calls?.[0].function.arguments).toContain("/d");
    expect(range.segments.map((s) => [s.originalStart, s.originalEnd])).toEqual([
      [1, 4], // 消えた促し (添字 2) を含む元の範囲
      [5, 6],
    ]);
  });
});

// ─── 2. 出力の検査 ───

describe("parseSummaryOutput (要約の型)", () => {
  it("区間の要約と 8 見出しを取り出す。 8 見出し以外の小見出しは中身として残す", () => {
    const text = validOutput(2).replace("Files and code sections の中身", "### src/a.ts\nparse() 120 行目");
    const r = parseSummaryOutput(`はい、 要約です。\n${text}`, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.segments).toEqual(["区間 1 の要約", "区間 2 の要約"]);
    expect(Object.keys(r.summary.sections)).toEqual([...SUMMARY_HEADINGS]);
    expect(r.summary.sections["Files and code sections"]).toBe("### src/a.ts\nparse() 120 行目");
    expect(r.summary.extraTextChars).toBeGreaterThan(0); // タグの外の前置きは数えて捨てる
  });

  it("見出しが欠ける・順が違う・中身が空・区間の数が違うときは問題を返す", () => {
    const missing = parseSummaryOutput(validOutput(1).replace("## Next step\nNext step の中身", ""), 1);
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) expect(missing.problems.join()).toContain("Next step");

    const swapped = validOutput(1).replace("## Pending tasks", "## TMP").replace("## Current work", "## Pending tasks");
    const order = parseSummaryOutput(swapped.replace("## TMP", "## Current work"), 1);
    expect(order.ok).toBe(false);

    const empty = parseSummaryOutput(validOutput(1).replace("Errors and fixes の中身", ""), 1);
    expect(empty.ok).toBe(false);

    const count = parseSummaryOutput(validOutput(1), 2);
    expect(count.ok).toBe(false);
    if (!count.ok) expect(count.problems[0]).toContain("n=1〜2");

    expect(parseSummaryOutput("", 1).ok).toBe(false);
  });

  it("本文に混ざった思考は除いてから読む", () => {
    const r = parseSummaryOutput(`<think><segment n="9">x</segment></think>${validOutput(1)}`, 1);
    expect(r.ok).toBe(true);
  });
});

// ─── 3. 要約の呼び出し ───

/** 本体の呼び出しと同じ形の request を MessageHistory から作る */
function mainRequest(history: MessageHistory, tools: ChatWithToolsParams["tools"]): MainCallRequest {
  return {
    method: "chatWithTools",
    params: { model: "m", messages: history.getMessages(), tools, stream: true, temperature: 0.3, maxTokens: 4096 },
  };
}

const TOOLS: ChatWithToolsParams["tools"] = [
  { type: "function", function: { name: "file_read", description: "read", parameters: { type: "object" } } },
];

function historyWith(messages: Message[]): MessageHistory {
  const h = new MessageHistory("SYSTEM");
  h.replaceMessages(messages);
  h.takeRewriteReasons();
  return h;
}

describe("requestSummary (キャッシュ済みの並び + 指示での要約)", () => {
  const budget = computeContextBudget(262_144, "T2");

  function setup() {
    const raw = [user("U1 を直して"), ...read("/a"), reply("直しました"), user("U2 も"), ...read("/b"), ...read("/c")];
    const history = historyWith(raw);
    const range = okRange(rangeOf(raw, 3000));
    return { raw, history, range };
  }

  it("AgentLoop の前回の本体呼び出しの並びをそのまま先頭に含み、 末尾に指示を 1 件足して送る", async () => {
    const requests: RecordedRequest[] = [];
    const big = "z".repeat(8000);
    const registry = new ToolRegistry();
    registry.register({
      name: "probe",
      definition: {
        type: "function",
        function: { name: "probe", description: "probe", parameters: { type: "object", properties: {} } },
      },
      execute: async () => ({ success: true, output: big }),
    });
    const security: SecurityConfig = {
      allowedDirectories: [],
      blockedCommands: [],
      rules: { allow: ["probe"], deny: [], ask: [] },
    };
    const replies = [
      toolCallChunks("p0", "probe"),
      toolCallChunks("p1", "probe"),
      toolCallChunks("p2", "probe"),
      toolCallChunks("p3", "probe"),
      textChunks("調べ終わりました。"),
    ];
    const provider = scriptedProvider(replies, requests);
    const loop = new AgentLoop(provider, "test-model-7b", registry, new PermissionManager(security), 128_000);
    await loop.run("調べてください？");

    const mainCalls = requests.length;
    const lastMain = requests[mainCalls - 1];
    const history = loop.getHistory();
    const raw = history.getRawMessages();
    const range = okRange(rangeOf(raw, 1, { keep: 0 }));
    replies.push(textChunks(validOutput(range.segments.length)));

    const records: SideCallRecord[] = [];
    setSideCallSink({ recordSideCall: (r) => records.push(r) });
    const result = await requestSummary({
      provider,
      request: {
        method: "chatWithTools",
        params: { ...lastMain.params, messages: history.getMessages() },
      },
      history: raw,
      range,
      promptTokens: 20_000,
      budget,
    });
    expect(result.ok).toBe(true);
    const sent = requests[mainCalls].params;
    // 前方一致: 前回の本体呼び出しの messages がそのまま先頭にあり、 tools・model・サンプリングも同じ
    expect(sent.messages.slice(0, lastMain.params.messages.length)).toEqual(lastMain.params.messages);
    expect(sent.tools).toEqual(lastMain.params.tools);
    expect(sent.model).toBe(lastMain.params.model);
    expect(sent.disableThinking).toBeUndefined();
    // 前回の本体呼び出しの後に足した出力 (最後の応答) と指示 1 件だけが増える
    expect(sent.messages).toHaveLength(lastMain.params.messages.length + 2);
    expect(sent.messages.at(-2)).toMatchObject({ role: "assistant", content: "調べ終わりました。" });
    const instruction = sent.messages.at(-1);
    expect(instruction?.role).toBe("user");
    expect(String(instruction?.content)).toContain("<context-summary-request>");
    expect(String(instruction?.content)).toContain("Do not call any tools");
    expect(records).toEqual([expect.objectContaining({ purpose: "summarize" })]);
  });

  it("出力上限は min(O, W − P − 指示 − M)。 思考の設定は渡されたまま", async () => {
    const { raw, history, range } = setup();
    const requests: RecordedRequest[] = [];
    const provider = scriptedProvider([textChunks(validOutput(range.segments.length))], requests);
    const roomy = await requestSummary({
      provider,
      request: mainRequest(history, TOOLS),
      history: raw,
      range,
      promptTokens: 50_000,
      budget,
    });
    expect(roomy.ok && roomy.maxTokens).toBe(budget.outputTokenLimit);
    expect(requests[0].params.maxTokens).toBe(budget.outputTokenLimit);
    expect(requests[0].params.temperature).toBe(0.3);
    expect(requests[0].method).toBe("chatWithTools");

    // 規則 1 の発火直前 (P = W − M − S) でも S − 指示 以上は残る
    const tight = budget.contextWindow - budget.estimateMarginTokens - budget.reductionMarginTokens;
    const requests2: RecordedRequest[] = [];
    const r2 = await requestSummary({
      provider: scriptedProvider([textChunks(validOutput(range.segments.length))], requests2),
      request: mainRequest(history, TOOLS),
      history: raw,
      range,
      promptTokens: tight,
      budget,
    });
    expect(r2.ok).toBe(true);
    expect(requests2[0].params.maxTokens).toBeLessThan(budget.reductionMarginTokens);
    expect(requests2[0].params.maxTokens).toBeGreaterThan(MIN_SUMMARY_OUTPUT_TOKENS);

    const none = await requestSummary({
      provider: scriptedProvider([], []),
      request: mainRequest(history, TOOLS),
      history: raw,
      range,
      promptTokens: budget.contextWindow,
      budget,
    });
    expect(none).toMatchObject({ ok: false, reason: "no-room" });
  });

  it("ツール呼び出しが返ったら 1 回だけ指示を強めて送り直す", async () => {
    const { raw, history, range } = setup();
    const requests: RecordedRequest[] = [];
    const provider = scriptedProvider(
      [toolCallChunks("x1", "file_read", { file_path: "/a" }), textChunks(validOutput(range.segments.length))],
      requests,
    );
    const result = await requestSummary({
      provider,
      request: mainRequest(history, TOOLS),
      history: raw,
      range,
      promptTokens: 50_000,
      budget,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(requests).toHaveLength(2);
    // 送り直しも同じ並び (履歴) の後ろに強めた指示 1 件
    const base = history.getMessages();
    for (const r of requests) {
      expect(r.params.messages.slice(0, base.length)).toEqual(JSON.parse(JSON.stringify(base)));
      expect(r.params.messages).toHaveLength(base.length + 1);
      expect(r.params.tools).toEqual(TOOLS);
    }
    const retried = String(requests[1].params.messages.at(-1)?.content);
    expect(retried).toContain("IMPORTANT");
    expect(retried).toContain("file_read");
  });

  it("2 回ともツールを呼んだら失敗を返す (別の手段に切り替えない)", async () => {
    const { raw, history, range } = setup();
    const requests: RecordedRequest[] = [];
    const result = await requestSummary({
      provider: scriptedProvider([toolCallChunks("x1", "file_read"), toolCallChunks("x2", "file_read")], requests),
      request: mainRequest(history, TOOLS),
      history: raw,
      range,
      promptTokens: 50_000,
      budget,
    });
    expect(result).toMatchObject({ ok: false, reason: "tool-call" });
    expect(result.attempts).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.params.disableThinking === undefined)).toBe(true);
  });

  it("型が揃わなければ問題を添えて 1 回だけ送り直し、 だめなら format で失敗", async () => {
    const { raw, history, range } = setup();
    const broken = validOutput(range.segments.length).replace("## Next step\nNext step の中身", "");
    const requests: RecordedRequest[] = [];
    const ok = await requestSummary({
      provider: scriptedProvider([textChunks(broken), textChunks(validOutput(range.segments.length))], requests),
      request: mainRequest(history, TOOLS),
      history: raw,
      range,
      promptTokens: 50_000,
      budget,
    });
    expect(ok.ok).toBe(true);
    expect(String(requests[1].params.messages.at(-1)?.content)).toContain("Next step");

    const ng = await requestSummary({
      provider: scriptedProvider([textChunks(broken), textChunks(broken)], []),
      request: mainRequest(history, TOOLS),
      history: raw,
      range,
      promptTokens: 50_000,
      budget,
    });
    expect(ng).toMatchObject({ ok: false, reason: "format" });
  });

  it("出力上限で切れたら送り直さずに length で失敗", async () => {
    const { raw, history, range } = setup();
    const requests: RecordedRequest[] = [];
    const result = await requestSummary({
      provider: scriptedProvider([textChunks("<segment n=", "length")], requests),
      request: mainRequest(history, TOOLS),
      history: raw,
      range,
      promptTokens: 50_000,
      budget,
    });
    expect(result).toMatchObject({ ok: false, reason: "length" });
    expect(requests).toHaveLength(1);
  });

  it("並びと元の履歴が対応していなければ例外 (目印が別のメッセージを指すのを防ぐ)", async () => {
    const { raw, history, range } = setup();
    await expect(
      requestSummary({
        provider: scriptedProvider([], []),
        request: mainRequest(history, TOOLS),
        history: raw.slice(1),
        range,
        promptTokens: 1000,
        budget,
      }),
    ).rejects.toThrow("対応していません");
  });

  it("指示は範囲の境界と区間の境界を、 利用者の発言の書き出しとツール呼び出しで示す", async () => {
    const { raw, history, range } = setup();
    const requests: RecordedRequest[] = [];
    await requestSummary({
      provider: scriptedProvider([textChunks(validOutput(range.segments.length))], requests),
      request: mainRequest(history, TOOLS),
      history: raw,
      range,
      promptTokens: 50_000,
      budget,
    });
    const text = String(requests[0].params.messages.at(-1)?.content);
    expect(range.segments).toHaveLength(2);
    expect(text).toContain("From the start of the conversation up to and including");
    expect(text).toContain('user message #2 (it begins: "U2 も")');
    expect(text).toContain("file_read /b"); // 範囲の最後 (/b の結果)
    expect(text).toContain("starting with your tool call file_read /c"); // 範囲の後ろは残す
    for (const h of SUMMARY_HEADINGS) expect(text).toContain(`## ${h}`);
  });
});

// ─── 4. 当てはめ ───

describe("applySummaryToCopy (写しへの当てはめ)", () => {
  it("利用者の発言は原文のまま元の位置に残し、 区間を要約の assistant メッセージに置き換える", () => {
    const u1: Message = { role: "user", content: "U1 を直して", contextNote: "# Current datetime\nx" };
    const u2 = user("U2 も");
    const messages = [u1, ...read("/a"), reply("直しました"), u2, ...read("/b"), ...read("/c")];
    const range = okRange(rangeOf(messages, 3000));
    const applied = applySummaryToCopy(messages, range, parsed(range.segments.length));

    const out = applied.messages;
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "assistant", "tool"]);
    expect(out[0]).toBe(u1); // 同じ参照 (原文・状態通知もそのまま)
    expect(out[2]).toBe(u2);
    expect(isReductionSummaryMessage(out[1])).toBe(true);
    expect(isReductionSummaryMessage(out[3])).toBe(true);
    // 区間ごとの要約。 全体の 8 見出しは最後の区間 (境界の直前) にだけ付ける
    expect(String(out[1].content)).toContain("区間 1 の要約");
    expect(String(out[1].content)).not.toContain("## Primary request and intent");
    for (const h of SUMMARY_HEADINGS) expect(String(out[3].content)).toContain(`## ${h}`);
    expect(String(out[3].content)).toContain("not an example of how to reply");
    expect(findToolPairingError(out)).toBeNull();
    expect(applied.freedTokens).toBeGreaterThan(ESTIMATED_OVERALL_SUMMARY_TOKENS);
    expect(applied.summaryIndices).toEqual([1, 3]);
    expect(applied.newIndexOf.slice(0, 7)).toEqual([0, 1, 1, 1, 2, 3, 3]);
    expect(messages).toHaveLength(9); // 入力は変えない

    // 次の整理の範囲は要約の次から
    const next = rangeOf([...out, ...read("/d"), ...read("/e")], 100);
    expect(next.ok && next.range.start).toBe(4);
  });

  it("区間の要約の数が合わなければ例外", () => {
    const messages = [user("U1"), ...read("/a"), ...read("/b"), ...read("/c")];
    const range = okRange(rangeOf(messages, 100));
    expect(() => applySummaryToCopy(messages, range, parsed(range.segments.length + 1))).toThrow("一致しません");
  });
});

// ─── 5. 状態の渡し直し ───

describe("状態の渡し直し", () => {
  it("要約した部分で触ったファイルを新しい順・重複なしで集める", () => {
    const messages = [
      user("U1"),
      ...read("C:\\work\\A.ts"),
      ...batch([call("file_write", { file_path: "c:/work/a.ts", content: "x" }), "ok"]),
      ...read("/b"),
      ...read("/later"),
    ];
    const files = collectRecentFiles(messages, { originalStart: 0, originalEnd: 7 }, true);
    expect(files.paths).toEqual(["/b", "c:/work/a.ts"]);
    expect(files.omitted).toBe(0);

    const many = Array.from({ length: RECENT_FILES_LISTED + 3 }, (_, i) => read(`/f${i}`)).flat();
    const listed = collectRecentFiles(many, { originalStart: 0, originalEnd: many.length }, false);
    expect(listed.paths).toHaveLength(RECENT_FILES_LISTED);
    expect(listed.paths[0]).toBe(`/f${RECENT_FILES_LISTED + 2}`);
    expect(listed.omitted).toBe(3);
  });

  it("次の状態通知に 1 回だけ添える (状態が変わっていなくても添え、 次の通知には付けない)", () => {
    const messages = [user("U1"), ...read("/a"), ...read("/b"), ...read("/c")];
    const range = okRange(rangeOf(messages, 100));
    const note = buildStateHandover(messages, range, parsed(range.segments.length));
    expect(note).toContain("/a");
    expect(note).toContain("src/app.ts の parse() を直している途中");

    const h = historyWith([user("U1"), ...read("/x")]);
    h.attachDynamicContext();
    h.addAssistantMessage("途中の発言");
    h.queueStateHandover(note);
    // 末尾が assistant の間は添えられず、 待たせたまま
    expect(h.attachDynamicContext()).toBe(false);
    expect(h.getPendingStateHandover()).toBe(note);

    h.addAssistantMessage("", [call("file_read", { file_path: "/y" }, "y1")]);
    h.addToolResult("y1", "結果");
    expect(h.attachDynamicContext()).toBe(true); // 状態 (dynamic) は前回と同じでも添える
    expect(h.getRawMessages().at(-1)?.contextNote).toContain("# After context reduction");
    expect(h.getPendingStateHandover()).toBeNull();

    h.addAssistantMessage("", [call("file_read", { file_path: "/z" }, "z1")]);
    h.addToolResult("z1", "結果");
    h.attachDynamicContext();
    expect(h.getRawMessages().at(-1)?.contextNote ?? "").not.toContain("# After context reduction");
  });
});
