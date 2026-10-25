import { describe, expect, it } from "vitest";
import { TIER_CONTEXT_BUDGETS } from "../../src/agent/capability-tier.js";
import {
  checkContextWindowFits,
  computeContextBudget,
  computeReductionGoal,
  DEFAULT_REQUEST_GROWTH_TOKENS,
  exceedsBoundaryLimit,
  exceedsForcedLimit,
  formatContextWindowTooSmall,
  MIN_CONVERSATION_TOKENS,
  measurePromptSize,
  RequestGrowthTracker,
  resolveRequestGrowth,
  toolResultLimitTokens,
} from "../../src/agent/context-budget.js";
import { estimateMessageTokens, estimateToolDefinitionTokens } from "../../src/agent/token-counter.js";
import type { Message, ToolDefinition } from "../../src/providers/base-provider.js";

const W_256K = 262_144;
const W_1M = 1_048_576;
const W_384K = 393_216;

describe("予約 R (docs/context-reduction-redesign.md §4.2)", () => {
  it("ティアごとの R = O + T + M + S", () => {
    expect(computeContextBudget(W_256K, "T1").reserveTokens).toBe(71_680);
    expect(computeContextBudget(W_256K, "T2").reserveTokens).toBe(67_584);
    expect(computeContextBudget(W_256K, "T3").reserveTokens).toBe(17_408);
  });

  it("T1・T2 とも O=32,768 / T=24,576 (§14.2-6)、 K は 6 / 5 / 3", () => {
    for (const tier of ["T1", "T2"] as const) {
      expect(TIER_CONTEXT_BUDGETS[tier].outputTokenLimit).toBe(32_768);
      expect(TIER_CONTEXT_BUDGETS[tier].toolResultTotalTokens).toBe(24_576);
    }
    expect(TIER_CONTEXT_BUDGETS.T1.keepRecentToolUses).toBe(6);
    expect(TIER_CONTEXT_BUDGETS.T2.keepRecentToolUses).toBe(5);
    expect(TIER_CONTEXT_BUDGETS.T3.keepRecentToolUses).toBe(3);
  });
});

describe("§4.7 の数字 (T1、 G = 80,000、 R = 71,680)", () => {
  const cases = [
    { w: W_256K, rule1: 190_464, rule2: 110_464 },
    { w: W_1M, rule1: 976_896, rule2: 896_896 },
    { w: W_384K, rule1: 321_536, rule2: 241_536 },
  ];
  for (const { w, rule1, rule2 } of cases) {
    it(`W = ${w}: 規則 1 は ${rule1} を超えたら、 規則 2 は ${rule2} を超えたら発火し、 目標は ${rule2}`, () => {
      const budget = computeContextBudget(w, "T1");
      const g = resolveRequestGrowth([], budget);
      expect(g).toMatchObject({ tokens: 80_000, source: "default", capped: false });

      expect(exceedsForcedLimit(rule1, budget)).toBe(false);
      expect(exceedsForcedLimit(rule1 + 1, budget)).toBe(true);
      expect(exceedsBoundaryLimit(rule2, budget, g.tokens)).toBe(false);
      expect(exceedsBoundaryLimit(rule2 + 1, budget, g.tokens)).toBe(true);

      const goal = computeReductionGoal(budget, g.tokens);
      expect(goal.targetPromptTokens).toBe(rule2);
      // F = max(32,768, 80,000 ÷ 2) = 40,000
      expect(goal.minimumReductionTokens).toBe(40_000);
    });
  }

  it("最低量 F は G が小さいとき 32,768 で下支えされる", () => {
    const budget = computeContextBudget(W_256K, "T1");
    expect(computeReductionGoal(budget, 20_000).minimumReductionTokens).toBe(32_768);
    expect(computeReductionGoal(budget, 70_000).minimumReductionTokens).toBe(35_000);
  });
});

describe("P の求め方 (§4.1)", () => {
  const messages: Message[] = [
    { role: "system", content: "あなたはアシスタントです。" },
    { role: "user", content: "hello world" },
  ];
  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: { name: "file_read", description: "read a file", parameters: { type: "object", properties: {} } },
    },
  ];
  const added: Message[] = [{ role: "tool", content: "ファイルの中身", tool_call_id: "c1" }];

  it("直前の本体呼び出しの実数があれば、 入力 + 出力 + その後に足した分の推定", () => {
    const size = measurePromptSize({
      lastMainCall: { promptTokens: 150_000, outputTokens: 1_200 },
      addedSinceLastCall: added,
      messages,
      tools,
    });
    expect(size).toEqual({ tokens: 150_000 + 1_200 + estimateMessageTokens(added), basis: "usage" });
  });

  it("実数が無いとき (起動直後・整理直後・usage を返さない provider) は、 メッセージとツール定義の推定", () => {
    const expected = estimateMessageTokens(messages) + estimateToolDefinitionTokens(tools);
    expect(estimateToolDefinitionTokens(tools)).toBeGreaterThan(0);
    for (const lastMainCall of [null, { promptTokens: 0, outputTokens: 0 }]) {
      expect(measurePromptSize({ lastMainCall, addedSinceLastCall: added, messages, tools })).toEqual({
        tokens: expected,
        basis: "estimate",
      });
    }
  });

  it("ツール定義が無ければ 0 と数える", () => {
    expect(estimateToolDefinitionTokens([])).toBe(0);
  });
});

describe("ひと仕事の増分 G (§4.5)", () => {
  const budget = computeContextBudget(W_256K, "T1");

  it("3 件そろうまでは既定 80,000、 そろったら直近 3 件の最大", () => {
    expect(resolveRequestGrowth([10_000, 20_000], budget)).toMatchObject({
      tokens: DEFAULT_REQUEST_GROWTH_TOKENS,
      source: "default",
    });
    expect(resolveRequestGrowth([10_000, 50_000, 20_000], budget)).toMatchObject({
      tokens: 50_000,
      source: "recent-max",
      capped: false,
    });
  });

  it("(W − R) ÷ 2 で頭打ちにする", () => {
    // (262,144 − 71,680) ÷ 2 = 95,232
    expect(resolveRequestGrowth([300_000, 1_000, 1_000], budget)).toEqual({
      tokens: 95_232,
      source: "recent-max",
      capped: true,
      capTokens: 95_232,
    });
  });

  it("既定値も頭打ちを受ける (小さい枠)", () => {
    const small = computeContextBudget(200_000, "T1");
    // (200,000 − 71,680) ÷ 2 = 64,160 < 80,000
    expect(resolveRequestGrowth([], small)).toMatchObject({ tokens: 64_160, source: "default", capped: true });
  });

  it("1 件の増分 = 最後の P + その出力 − 最初の P、 途中の整理で減らした量は足し戻す", () => {
    const t = new RequestGrowthTracker();
    t.beginRequest();
    t.noteMainCall(100_000, 500);
    t.noteMainCall(120_000, 800);
    // 整理で 60,000 減らした後の呼び出し
    t.noteReduction(60_000);
    t.noteMainCall(70_000, 1_000);
    expect(t.endRequest()).toBe(70_000 + 1_000 - 100_000 + 60_000);
    expect(t.recentGrowths()).toEqual([31_000]);
  });

  it("直近 3 件だけを持ち、 古いものから落とす", () => {
    const t = new RequestGrowthTracker();
    for (const g of [1_000, 2_000, 3_000, 4_000]) {
      t.beginRequest();
      t.noteMainCall(10_000, 0);
      t.noteMainCall(10_000 + g, 0);
      t.endRequest();
    }
    expect(t.recentGrowths()).toEqual([2_000, 3_000, 4_000]);
    expect(t.resolve(budget)).toMatchObject({ tokens: 4_000, source: "recent-max" });
  });

  it("本体呼び出しの実数が無い依頼は記録しない (作り話で埋めない)", () => {
    const t = new RequestGrowthTracker();
    expect(t.endRequest()).toBeNull();
    t.beginRequest();
    expect(t.endRequest()).toBeNull();
    t.noteMainCall(10_000, 0); // 依頼の外
    t.noteReduction(5_000); // 依頼の外
    expect(t.recentGrowths()).toEqual([]);
  });

  it("前の依頼が終わらないまま次が始まったら、 前の分を記録してから始める", () => {
    const t = new RequestGrowthTracker();
    t.beginRequest();
    t.noteMainCall(10_000, 100);
    t.noteMainCall(15_000, 100);
    t.beginRequest();
    expect(t.recentGrowths()).toEqual([5_100]);
  });

  it("保存と復元: 直近の記録と途中の依頼が戻り、 続きから測れる", () => {
    const t = new RequestGrowthTracker();
    t.beginRequest();
    t.noteMainCall(10_000, 0);
    t.noteMainCall(30_000, 0);
    t.endRequest();
    t.beginRequest();
    t.noteMainCall(40_000, 200);
    const saved = JSON.parse(JSON.stringify(t.toSnapshot()));
    expect(saved).toEqual({
      version: 1,
      recent: [20_000],
      current: { firstPromptTokens: 40_000, lastPromptTokens: 40_000, lastOutputTokens: 200, reducedTokens: 0 },
    });

    const restored = RequestGrowthTracker.restore(saved);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    restored.tracker.noteMainCall(55_000, 300);
    expect(restored.tracker.endRequest()).toBe(15_300);
    expect(restored.tracker.recentGrowths()).toEqual([20_000, 15_300]);
  });

  it("記録の無い古いセッションは空の記録から始める", () => {
    const restored = RequestGrowthTracker.restore(undefined);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.tracker.toSnapshot()).toEqual({ version: 1, recent: [], current: null });
  });

  it("壊れた記録は黙って空にせず、 失敗として返す", () => {
    const bad: unknown[] = [
      null,
      { version: 2, recent: [], current: null },
      { version: 1, recent: [-1], current: null },
      { version: 1, recent: ["1"], current: null },
      { version: 1, recent: [1, 2, 3, 4], current: null },
      { version: 1, recent: [], current: { firstPromptTokens: "x" } },
      { version: 1, recent: [] },
    ];
    for (const raw of bad) {
      const r = RequestGrowthTracker.restore(raw);
      expect(r.ok, JSON.stringify(raw)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/requestGrowth/);
    }
  });
});

describe("起動時の検査 (§6.3)", () => {
  it("固定部分 + K × 1 件の上限 + 16,384 + R ≤ W なら通る", () => {
    // T2: K=5、 12KB の切り詰め、 R=67,584
    const fit = checkContextWindowFits({
      contextWindow: W_1M,
      tier: "T2",
      fixedTokens: 20_000,
      toolResultLimitChars: 12 * 1024,
    });
    const perItem = toolResultLimitTokens(12 * 1024);
    expect(fit).toEqual({
      ok: true,
      contextWindow: W_1M,
      requiredTokens: 20_000 + 5 * perItem + MIN_CONVERSATION_TOKENS + 67_584,
      fixedTokens: 20_000,
      keepRecentToolUses: 5,
      recentToolResultTokens: 5 * perItem,
      conversationTokens: 16_384,
      reserveTokens: 67_584,
    });
  });

  it("1 件の上限は推定で最も多く数える場合 (全角 1 文字 = 1.1 トークン) をとる", () => {
    // 6KB の閾値 + 注記 200 字
    expect(toolResultLimitTokens(6 * 1024)).toBe(Math.ceil((6 * 1024 + 200) * 1.1));
  });

  it("ちょうど W に等しければ通り、 1 でも超えれば止める", () => {
    const base = { tier: "T3" as const, fixedTokens: 5_000, toolResultLimitChars: 6 * 1024 };
    const required = checkContextWindowFits({ ...base, contextWindow: 1 }).requiredTokens;
    expect(checkContextWindowFits({ ...base, contextWindow: required }).ok).toBe(true);
    const tooSmall = checkContextWindowFits({ ...base, contextWindow: required - 1 });
    expect(tooSmall.ok).toBe(false);
    const message = formatContextWindowTooSmall(tooSmall, "qwen2.5-7b", "T3");
    expect(message).toContain("contextWindow が小さすぎます");
    expect(message).toContain(required.toLocaleString("en-US"));
    expect(message).toContain("直近 3 回のツール結果");
  });

  it("T3 の 32K 枠は入らない (R と会話の最小限だけで 33,792)", () => {
    const fit = checkContextWindowFits({
      contextWindow: 32_768,
      tier: "T3",
      fixedTokens: 0,
      toolResultLimitChars: 6 * 1024,
    });
    expect(fit.ok).toBe(false);
  });
});
