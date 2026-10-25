import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { CacheMissCauseCollector } from "../../src/agent/cache-miss.js";
import { computeContextBudget, RequestGrowthTracker } from "../../src/agent/context-budget.js";
import { MessageHistory, findToolPairingError } from "../../src/agent/message-history.js";
import {
  type ReductionEventInput,
  buildReductionTombstoneText,
  formatReductionEventLine,
  previewReduction,
  runReductionEvent,
} from "../../src/agent/reduction-event.js";
import { TOMBSTONE_MARKER } from "../../src/agent/reduction-stages.js";
import {
  SUMMARY_HEADINGS,
  type MainCallRequest,
  isReductionSummaryMessage,
} from "../../src/agent/reduction-summary.js";
import { saveSession, type SessionData } from "../../src/agent/session-manager.js";
import { setSideCallSink } from "../../src/agent/side-call.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type {
  ChatChunk,
  ChatWithToolsParams,
  LLMProvider,
  Message,
  ToolCall,
} from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { clearTodos } from "../../src/tools/definitions/todo-write.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

/** 整理イベント: 1 回の書き換え (docs/context-reduction-redesign.md §6.1。 整理の作り直し タスク 7) */

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
const read = (path: string): Message[] => batch(call("file_read", { file_path: path }), BIG);

const TOOLS: ChatWithToolsParams["tools"] = [
  { type: "function", function: { name: "file_read", description: "read", parameters: { type: "object" } } },
];

/** 要約の指示から区間の数を読み、 型どおりの要約を返す (要約以外の呼び出しは来ない前提) */
function summaryOutput(instruction: string): string {
  const n = Number(/for each of the (\d+) segments/.exec(instruction)?.[1] ?? "0");
  const segs = Array.from({ length: n }, (_, i) => `<segment n="${i + 1}">区間 ${i + 1} でしたこと</segment>`);
  const body = SUMMARY_HEADINGS.map((h) => `## ${h}\n${h === "Current work" ? "/src/app.ts を直している" : "None"}`);
  return `${segs.join("\n")}\n<summary>\n${body.join("\n\n")}\n</summary>`;
}

type SummaryBehavior = "valid" | "garbage" | "throw";

function summaryProvider(behavior: SummaryBehavior, sent: ChatWithToolsParams[]): LLMProvider {
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    sent.push(JSON.parse(JSON.stringify(params)));
    if (behavior === "throw") throw new Error("サーバに接続できません");
    const instruction = String(params.messages.at(-1)?.content ?? "");
    yield { type: "text", text: behavior === "valid" ? summaryOutput(instruction) : "要約です (型なし)" };
    yield {
      type: "done",
      finishReason: "stop",
      usage: { promptTokens: 90_000, completionTokens: 1_200, cachedTokens: 88_000 },
    };
  };
  return { providerType: "llamacpp", chat: chatWithTools, chatWithTools } as unknown as LLMProvider;
}

function historyWith(messages: Message[]): MessageHistory {
  const h = new MessageHistory("SYSTEM");
  h.replaceMessages(messages);
  h.takeRewriteReasons();
  return h;
}

function mainRequest(history: MessageHistory): MainCallRequest {
  return {
    method: "chatWithTools",
    params: { model: "m", messages: history.getMessages(), tools: TOOLS, stream: true, maxTokens: 32_768 },
  };
}

const budget = computeContextBudget(262_144, "T2"); // R = 67,584。 G = 80,000 なら目標 114,560・最低量 40,000

function eventInput(
  history: MessageHistory,
  overrides: Partial<ReductionEventInput> & { behavior?: SummaryBehavior; sent?: ChatWithToolsParams[] } = {},
): ReductionEventInput {
  const { behavior = "valid", sent = [], ...rest } = overrides;
  return {
    id: "r-1",
    trigger: "boundary:request-end",
    history,
    provider: summaryProvider(behavior, sent),
    budget,
    keepRecentToolUses: 1,
    promptSize: { tokens: 150_000, basis: "usage" },
    growthTokens: 80_000,
    currentRequestStart: history.getMessageCount(),
    buildMainCallRequest: () => mainRequest(history),
    cacheMissCauses: new CacheMissCauseCollector(),
    growth: new RequestGrowthTracker(),
    caseInsensitivePaths: true,
    summaryFailure: "continue",
    ...rest,
  };
}

/** 古いツール結果が多い履歴 (段階 1 だけで 4 万トークン以上減る) */
function toolHeavyHistory(): Message[] {
  const out: Message[] = [user("調べて")];
  for (let i = 0; i < 25; i++) out.push(...read(`/f${i}`));
  out.push(reply("調べました"));
  return out;
}

/** 古いツール結果が少しと、 モデルの長い発言が多い履歴 (段階 0〜2 で少し減るが、 最低量には要約が要る) */
function mixedHistory(): Message[] {
  const out: Message[] = [user("U1 を説明して")];
  for (let i = 0; i < 6; i++) out.push(...read(`/m${i}`));
  for (let i = 0; i < 12; i++) out.push(reply(`説明 ${i} ${BIG}`));
  out.push(user("U2 も説明して"));
  for (let i = 0; i < 12; i++) out.push(reply(`説明 ${i} ${BIG}`));
  out.push(...read("/last"));
  return out;
}

/** モデルの長い発言が多い履歴 (段階 0〜2 では減らず、 要約が要る) */
function replyHeavyHistory(): Message[] {
  const out: Message[] = [user("U1 を説明して")];
  for (let i = 0; i < 12; i++) out.push(reply(`説明 ${i} ${BIG}`));
  out.push(user("U2 も説明して"));
  for (let i = 0; i < 12; i++) out.push(reply(`説明 ${i} ${BIG}`));
  out.push(...read("/last"));
  return out;
}

// ─── 段階 0〜2 だけで足りるとき ───

describe("整理イベント (要約なし)", () => {
  it("履歴を 1 回だけ差し替え、 理由 reduction:<id> を申告し、 cache_miss の原因に記録する", async () => {
    const history = historyWith(toolHeavyHistory());
    const revision = history.getRevision();
    const input = eventInput(history);
    const result = await runReductionEvent(input);

    expect(result.ok).toBe(true);
    expect(history.getRevision()).toBe(revision + 1);
    expect(history.takeRewriteReasons()).toEqual(["reduction:r-1"]);
    expect(input.cacheMissCauses.take([]).reductionEventIds).toEqual(["r-1"]);
    expect(findToolPairingError(history.getRawMessages())).toBeNull();
    // 呼び出しは残り、 結果の本文だけが消える
    const raw = history.getRawMessages();
    expect(raw.filter((m) => m.tool_calls).length).toBe(25);
    expect(raw.filter((m) => m.role === "tool" && String(m.content).startsWith("[忘却済み]")).length).toBe(24);
  });

  it("reduction_event の欄を埋める (§10.1)", async () => {
    const history = historyWith(toolHeavyHistory());
    const result = await runReductionEvent(eventInput(history));
    const r = result.record;
    expect(r).toMatchObject({
      id: "r-1",
      trigger: "boundary:request-end",
      ok: true,
      promptTokensBefore: 150_000,
      promptBasis: "usage",
      targetPromptTokens: 262_144 - 67_584 - 80_000,
      minimumReductionTokens: 40_000,
      growthTokens: 80_000,
      reachedStage: 2,
      summary: { status: "not-needed" },
      prewarm: null,
    });
    expect(r.freedTokens.stage1).toBeGreaterThan(40_000);
    expect(r.freedTokens.stage3).toBe(0);
    // total は忘却の記録の分を差し引いた実際の差
    expect(r.freedTokens.total).toBeLessThan(r.freedTokens.stage1);
    expect(r.promptTokensAfter).toBe(150_000 - r.freedTokens.total);
    expect(r.forgottenCalls).toBe(24);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(formatReductionEventLine(result)).toContain("r-1");
  });

  it("忘却の記録は 1 件にまとめ、 既存の記録に追記する", async () => {
    const existing: Message = { role: "system", content: `${TOMBSTONE_MARKER} 前回の分` };
    const history = historyWith([existing, ...toolHeavyHistory()]);
    await runReductionEvent(eventInput(history));
    const notes = history.getRawMessages().filter((m) => String(m.content).startsWith(TOMBSTONE_MARKER));
    expect(notes).toHaveLength(1);
    expect(String(notes[0].content)).toContain("前回の分");
    expect(String(notes[0].content)).toContain("整理 r-1");
  });

  it("前処理で終わった依頼の揮発メッセージと思考を返し、 今の依頼のものは残す", async () => {
    const raw: Message[] = [
      ...toolHeavyHistory(),
      { role: "user", content: "(ハーネスの促し 前)", ephemeral: true },
      { role: "assistant", content: "前の答え", thinking: "前の考え" },
      user("今の依頼"),
      { role: "user", content: "(ハーネスの促し 今)", ephemeral: true },
      { role: "assistant", content: "途中", thinking: "今の考え" },
    ];
    const history = historyWith(raw);
    const result = await runReductionEvent(eventInput(history, { currentRequestStart: raw.length - 3 }));
    expect(result.record.repaid).toEqual({ ephemeral: 1, thinking: 1 });
    const after = history.getRawMessages();
    expect(after.some((m) => m.content === "(ハーネスの促し 前)")).toBe(false);
    expect(after.find((m) => m.content === "前の答え")?.thinking).toBeUndefined();
    expect(after.find((m) => m.content === "(ハーネスの促し 今)")?.ephemeral).toBe(true);
    expect(after.find((m) => m.content === "途中")?.thinking).toBe("今の考え");
  });

  it("依頼の途中の整理で減らした量を、 依頼の増分 G に足し戻す", async () => {
    const history = historyWith(toolHeavyHistory());
    const growth = new RequestGrowthTracker();
    growth.beginRequest();
    growth.noteMainCall(100_000, 500);
    const result = await runReductionEvent(eventInput(history, { growth }));
    expect(growth.toSnapshot().current?.reducedTokens).toBe(result.record.freedTokens.total);
  });
});

// ─── 段階 3 (要約) ───

describe("整理イベント (要約あり)", () => {
  it("書き換え前の並び + 指示で要約を得て当てはめ、 利用者の発言は原文のまま残す", async () => {
    const raw = replyHeavyHistory();
    const history = historyWith(raw);
    const before = history.getMessages();
    const sent: ChatWithToolsParams[] = [];
    const result = await runReductionEvent(
      eventInput(history, { sent, promptSize: { tokens: 100_000, basis: "estimate" } }),
    );

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    // 要約の呼び出しは書き換え前の並びをそのまま先頭に含む (キャッシュを使う)
    expect(sent[0].messages.slice(0, before.length)).toEqual(JSON.parse(JSON.stringify(before)));
    expect(String(sent[0].messages.at(-1)?.content)).toContain("<context-summary-request>");

    const after = history.getRawMessages();
    expect(after.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["U1 を説明して", "U2 も説明して"]);
    expect(after.some(isReductionSummaryMessage)).toBe(true);
    expect(history.takeRewriteReasons()).toEqual(["reduction:r-1"]);

    const r = result.record;
    expect(r.reachedStage).toBe(3);
    expect(r.summary).toMatchObject({
      status: "done",
      attempts: 1,
      tokensIn: 90_000,
      tokensCached: 88_000,
      tokensOut: 1_200,
    });
    expect(r.freedTokens.stage3).toBeGreaterThan(0);
    // 状態の渡し直しを預ける (次の状態通知に 1 回だけ添える)
    expect(history.getPendingStateHandover()).toContain("/src/app.ts を直している");
    expect(formatReductionEventLine(result)).toContain("要約");
  });

  it("設定 stop: 要約を得られなければ失敗とし、 履歴は元のまま", async () => {
    const raw = mixedHistory();
    const history = historyWith(raw);
    const revision = history.getRevision();
    const input = eventInput(history, {
      behavior: "garbage",
      summaryFailure: "stop",
      promptSize: { tokens: 100_000, basis: "estimate" },
    });
    const result = await runReductionEvent(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("summary-failed");
    expect(result.record.summary).toMatchObject({ status: "failed", failureReason: "format", attempts: 2 });
    expect(result.record).toMatchObject({ summaryFailurePolicy: "stop", continuedWithoutSummary: false });
    expect(history.getRawMessages()).toEqual(raw);
    expect(history.getRevision()).toBe(revision);
    expect(history.takeRewriteReasons()).toEqual([]);
    expect(input.cacheMissCauses.take([]).reductionEventIds).toEqual([]);
    expect(history.getPendingStateHandover()).toBeNull();
    expect(formatReductionEventLine(result)).toContain("履歴は変えていません");
  });

  it("設定 stop: 要約の呼び出しでエラーが起きても、 履歴は元のまま", async () => {
    const raw = mixedHistory();
    const history = historyWith(raw);
    const result = await runReductionEvent(
      eventInput(history, {
        behavior: "throw",
        summaryFailure: "stop",
        promptSize: { tokens: 100_000, basis: "estimate" },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("summary-error");
    expect(result.detail).toContain("サーバに接続できません");
    expect(history.getRawMessages()).toEqual(raw);
  });
});

// ─── 要約の失敗の扱い (設定 context.summaryFailure。 2026-10-25 利用者の決定) ───

describe("整理イベント: 要約に失敗したとき、 設定 continue (既定) は段階 0〜2 の分だけで進める", () => {
  it.each([
    { behavior: "garbage" as const, status: "failed", detail: "要約を得られませんでした" },
    { behavior: "throw" as const, status: "error", detail: "サーバに接続できません" },
  ])("要約の失敗 ($status) を記録と 1 行に出し、 段階 0〜2 の写しで 1 回だけ差し替える", async ({
    behavior,
    status,
    detail,
  }) => {
    const raw = mixedHistory();
    const history = historyWith(raw);
    const input = eventInput(history, { behavior, promptSize: { tokens: 100_000, basis: "estimate" } });
    const result = await runReductionEvent(input);

    expect(result.ok).toBe(true);
    const r = result.record;
    expect(r).toMatchObject({ reachedStage: 3, summaryFailurePolicy: "continue", continuedWithoutSummary: true });
    expect(r.summary.status).toBe(status);
    expect(r.summary.failureDetail).toContain(detail);
    expect(r.freedTokens.stage3).toBe(0);
    expect(r.freedTokens.total).toBeGreaterThan(0);
    // 要約は入らず、 古いツール結果だけが消える。 利用者の発言は原文のまま
    const after = history.getRawMessages();
    expect(after.some(isReductionSummaryMessage)).toBe(false);
    expect(after.filter((m) => m.role === "tool" && String(m.content).startsWith("[忘却済み]")).length).toBe(6);
    expect(after.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["U1 を説明して", "U2 も説明して"]);
    expect(history.takeRewriteReasons()).toEqual(["reduction:r-1"]);
    expect(history.getPendingStateHandover()).toBeNull();
    // 黙らない: 利用者向けの 1 行に、 要約に失敗したことと中身が出る
    const line = formatReductionEventLine(result);
    expect(line).toContain("要約に失敗");
    expect(line).toContain(detail);
  });

  it("規則 1 で、 段階 0〜2 だけでは次の呼び出しが入らなければ止める (入らない呼び出しは送らない)", async () => {
    const raw = mixedHistory();
    const history = historyWith(raw);
    const result = await runReductionEvent(
      eventInput(history, { behavior: "garbage", trigger: "forced", promptSize: { tokens: 250_000, basis: "usage" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("still-too-large");
    expect(result.record.continuedWithoutSummary).toBe(true);
    expect(result.detail).toContain("要約を得られませんでした");
    expect(history.getRawMessages()).toEqual(raw);
    expect(history.takeRewriteReasons()).toEqual([]);
  });

  it("Esc で要約が切れたとき (signal が中断済み) は、 continue でも失敗にして履歴を変えない", async () => {
    const raw = mixedHistory();
    const history = historyWith(raw);
    const controller = new AbortController();
    controller.abort();
    const result = await runReductionEvent(
      eventInput(history, {
        behavior: "throw",
        signal: controller.signal,
        promptSize: { tokens: 100_000, basis: "estimate" },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("summary-error");
    expect(result.record.continuedWithoutSummary).toBe(false);
    expect(history.getRawMessages()).toEqual(raw);
  });
});

// ─── 手動の /compact と /context の見込み (タスク 10) ───

/** 古いツール結果が多く (段階 1 だけで目標と最低量に届く)、 モデルの長い発言もある履歴 */
function toolAndReplyHistory(): Message[] {
  const out: Message[] = [user("U1 を調べて")];
  for (let i = 0; i < 25; i++) out.push(...read(`/f${i}`));
  for (let i = 0; i < 6; i++) out.push(reply(`説明 ${i} ${BIG}`));
  out.push(user("U2 も説明して"));
  for (let i = 0; i < 6; i++) out.push(reply(`説明 ${i} ${BIG}`));
  out.push(...read("/last"));
  return out;
}

describe("手動の /compact: 段階 0〜3 を最後まで進める (§7)", () => {
  it("規則による整理は段階 0〜2 で足りれば要約しないが、 手動は要約してよい最大の範囲を要約する", async () => {
    const boundarySent: ChatWithToolsParams[] = [];
    const boundary = await runReductionEvent(
      eventInput(historyWith(toolAndReplyHistory()), { sent: boundarySent, trigger: "boundary:request-end" }),
    );
    expect(boundary.ok).toBe(true);
    expect(boundary.record.summary.status).toBe("not-needed");
    expect(boundarySent).toHaveLength(0);

    const history = historyWith(toolAndReplyHistory());
    const sent: ChatWithToolsParams[] = [];
    const manual = await runReductionEvent(eventInput(history, { sent, trigger: "manual" }));
    expect(manual.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(manual.record).toMatchObject({ reachedStage: 3, summary: { status: "done" } });
    expect(manual.record.freedTokens.stage3).toBeGreaterThan(0);
    // 最大の範囲: 保護部分 (直近 K=1 回のツール呼び出し) の手前までのモデルの長い発言は全部要約に入る
    const after = history.getRawMessages();
    expect(after.filter((m) => m.role === "assistant" && String(m.content).includes(BIG))).toHaveLength(0);
    expect(after.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["U1 を調べて", "U2 も説明して"]);
  });

  it("手動でも要約してよい範囲が無ければ要約を呼ばず、 段階 0〜2 の分だけで整理する", async () => {
    const sent: ChatWithToolsParams[] = [];
    const result = await runReductionEvent(eventInput(historyWith(toolHeavyHistory()), { sent, trigger: "manual" }));
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(0);
    expect(result.record.summary.status).toBe("nothing-to-summarize");
  });
});

describe("previewReduction: 今 /compact した場合の見込み (要約は呼ばない)", () => {
  const previewInput = (messages: Message[]) => ({
    messages,
    budget,
    promptSize: { tokens: 150_000, basis: "usage" as const },
    growthTokens: 80_000,
    keepRecentToolUses: 1,
    currentRequestStart: messages.length,
    caseInsensitivePaths: true,
  });

  it("段階 0〜2 の量は整理イベントと同じで、 要約は範囲を決めるだけ。 履歴は変えない", async () => {
    const history = historyWith(toolAndReplyHistory());
    const raw = history.getRawMessages();
    const revision = history.getRevision();
    const preview = previewReduction(previewInput(raw));
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(history.getRawMessages()).toEqual(raw);
    expect(history.getRevision()).toBe(revision);
    expect(preview.goal).toEqual({ targetPromptTokens: 262_144 - 67_584 - 80_000, minimumReductionTokens: 40_000 });
    expect(preview.needsSummary).toBe(false);
    expect(preview.shortfall).toEqual({ toTarget: 0, toMinimum: 0 });
    expect(preview.summary.status).toBe("would-summarize");
    if (preview.summary.status === "would-summarize") {
      expect(preview.summary.segments).toBeGreaterThan(0);
      expect(preview.summary.estimatedFreedTokens).toBeGreaterThan(0);
    }

    const event = await runReductionEvent(
      eventInput(historyWith(toolAndReplyHistory()), { trigger: "boundary:request-end" }),
    );
    const f = event.record.freedTokens;
    expect(preview.freedTokens).toEqual({
      preprocess: f.preprocess,
      stage0: f.stage0,
      stage1: f.stage1,
      stage2: f.stage2,
      total: preview.freedTokens.total,
    });
    expect(preview.freedTokens.stage1).toBeGreaterThan(0);
    expect(preview.forgottenCalls).toBe(event.record.forgottenCalls);
  });

  it("段階 0〜2 で足りないときは不足量を返し、 要約できる範囲が無ければそう返す", () => {
    const messages = [user("こんにちは"), reply("こんにちは")];
    const preview = previewReduction(previewInput(messages));
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.needsSummary).toBe(true);
    expect(preview.shortfall.toTarget).toBe(150_000 - (262_144 - 67_584 - 80_000));
    expect(preview.shortfall.toMinimum).toBe(40_000);
    expect(preview.summary.status).toBe("nothing-to-summarize");
    expect(preview.freedTokens.total).toBe(0);
  });
});

// ─── 書き換えないとき ───

describe("整理イベント (書き換えない)", () => {
  it("減らせるものが無ければ書き換えない", async () => {
    const raw = [user("こんにちは"), reply("こんにちは")];
    const history = historyWith(raw);
    const result = await runReductionEvent(eventInput(history, { promptSize: { tokens: 20_000, basis: "usage" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("nothing-to-reduce");
    expect(history.getRawMessages()).toEqual(raw);
    expect(history.takeRewriteReasons()).toEqual([]);
  });

  it("規則 1 で、 整理しても次の呼び出しが入らなければ失敗とし、 履歴は元のまま", async () => {
    const raw = [user("調べて"), ...read("/a"), ...read("/b"), reply("調べました")];
    const history = historyWith(raw);
    const result = await runReductionEvent(
      eventInput(history, { trigger: "forced", promptSize: { tokens: 250_000, basis: "usage" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("still-too-large");
    expect(history.getRawMessages()).toEqual(raw);
    expect(history.takeRewriteReasons()).toEqual([]);
  });
});

describe("忘却の記録の本文", () => {
  it("見出しにイベント ID、 末尾に読み直しの案内", () => {
    const text = buildReductionTombstoneText("r-9", ["- 本文のみ削除: file_read×2"]);
    expect(text.startsWith(`${TOMBSTONE_MARKER} 整理 r-9`)).toBe(true);
    expect(text).toContain("file_read×2");
    expect(text).toContain("再度ツールで取得");
  });
});

// ─── AgentLoop: 揮発の印の保存・再開と、 規則 1 の失敗 ───

function securityConfig(allowedTools: string[]): SecurityConfig {
  return { allowedDirectories: [], blockedCommands: [], rules: { allow: [...allowedTools], deny: [], ask: [] } };
}

function scriptedProvider(replies: ChatChunk[][], requests: ChatWithToolsParams[]): LLMProvider {
  let call = 0;
  const chatWithTools = async function* (params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    requests.push(JSON.parse(JSON.stringify(params)));
    for (const chunk of replies[Math.min(call++, replies.length - 1)] ?? []) yield chunk;
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

function probeRegistry(output: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "probe",
    definition: {
      type: "function",
      function: { name: "probe", description: "probe", parameters: { type: "object", properties: {} } },
    },
    execute: async () => ({ success: true, output }),
  });
  return registry;
}

function toolCallChunks(id: string, usage?: { promptTokens: number; completionTokens: number }): ChatChunk[] {
  return [
    { type: "thinking", text: `考え ${id}` },
    {
      type: "tool_call",
      toolCall: { id, type: "function", function: { name: "probe", arguments: `{"tag":"${id}"}` } },
    },
    { type: "done", finishReason: "tool_calls", usage },
  ];
}

describe("AgentLoop: 揮発の印の保存・再開", () => {
  it("応答の終わりでは揮発メッセージも思考も消えず、 保存・再開しても残り、 送る形からは外れる", async () => {
    const requests: ChatWithToolsParams[] = [];
    const provider = scriptedProvider(
      [
        toolCallChunks("p1"),
        [
          { type: "thinking", text: "前半の考え" },
          { type: "text", text: "前半" },
          { type: "done", finishReason: "length" },
        ],
        [
          { type: "text", text: "後半です。" },
          { type: "done", finishReason: "stop" },
        ],
      ],
      requests,
    );
    const registry = probeRegistry("ok");
    const loop = new AgentLoop(
      provider,
      "test-model-7b",
      registry,
      new PermissionManager(securityConfig(["probe"])),
      128_000,
    );
    await loop.run("調べてください？");

    const raw = loop.getHistory().getRawMessages();
    const nudge = raw.find((m) => m.ephemeral === true);
    expect(nudge?.role).toBe("user"); // 「続きを出力」 の促しが応答の後も残る (次の整理イベントで返す)
    expect(raw.some((m) => m.thinking === "考え p1")).toBe(true);

    loop.saveCurrentSession();
    const saved = vi.mocked(saveSession).mock.calls.at(-1)?.[0] as SessionData;
    const copy = JSON.parse(JSON.stringify(saved)) as SessionData;
    expect(copy.messages.some((m) => m.ephemeral === true)).toBe(true);

    const loop2 = new AgentLoop(
      provider,
      "test-model-7b",
      registry,
      new PermissionManager(securityConfig(["probe"])),
      128_000,
    );
    loop2.restoreSession(copy);
    const restored = loop2.getHistory().getRawMessages();
    expect(restored.map((m) => m.ephemeral === true)).toEqual(raw.map((m) => m.ephemeral === true));
    expect(restored.map((m) => m.thinking)).toEqual(raw.map((m) => m.thinking));
    for (const m of loop2.getHistory().getMessages()) expect(m).not.toHaveProperty("ephemeral");
    for (const r of requests) for (const m of r.messages) expect(m).not.toHaveProperty("ephemeral");
  });
});

describe("AgentLoop: 規則 1 の整理に失敗したら本体呼び出しを出さずに止める", () => {
  it("入らない呼び出しは送らず、 履歴の書き換えも無く、 失敗を記録する", async () => {
    const requests: ChatWithToolsParams[] = [];
    const W = 128_000;
    // 2 回目の応答の usage で P を枠の近くまで上げる (実数の土台。 段階 0〜2 では減らせない量)
    const provider = scriptedProvider(
      [toolCallChunks("p1"), toolCallChunks("p2", { promptTokens: W - 1_000, completionTokens: 10 })],
      requests,
    );
    const loop = new AgentLoop(
      provider,
      "test-model-7b",
      probeRegistry("ok"),
      new PermissionManager(securityConfig(["probe"])),
      W,
    );
    const replace = vi.spyOn(MessageHistory.prototype, "replaceMessages");
    const outcomes: string[] = [];
    loop.events.on("task_complete", (e) => outcomes.push(e.outcome));
    try {
      await loop.run("調べてください？");
    } finally {
      replace.mockRestore();
    }

    expect(requests).toHaveLength(2); // 3 回目の本体呼び出しは送っていない
    expect(replace).not.toHaveBeenCalled();
    expect(outcomes).toEqual(["error"]);
    const last = loop.getHistory().getRawMessages().at(-1);
    expect(String(last?.content)).toContain("コンテキストの整理に失敗したため送れませんでした");
  });
});
