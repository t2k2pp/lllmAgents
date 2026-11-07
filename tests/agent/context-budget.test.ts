import { describe, expect, it } from "vitest";
import { TIER_CONTEXT_BUDGETS } from "../../src/agent/capability-tier.js";
import {
  checkContextWindowFits,
  checkUserInputFits,
  computeContextBudget,
  computeMainOutputTokens,
  computeReductionGoal,
  DEFAULT_REQUEST_GROWTH_TOKENS,
  exceedsBoundaryLimit,
  exceedsForcedLimit,
  exceedsMinimumLimit,
  findMinimumContextWindow,
  formatContextWindowTooSmall,
  formatUserInputTooLarge,
  MAX_RESERVE_RATIO,
  MIN_CONVERSATION_TOKENS,
  MIN_MAIN_OUTPUT_TOKENS,
  measurePromptSize,
  RequestGrowthTracker,
  resolveRequestGrowth,
} from "../../src/agent/context-budget.js";
import { estimateMessageTokens, estimateToolDefinitionTokens } from "../../src/agent/token-counter.js";
import type { Message, ToolDefinition } from "../../src/providers/base-provider.js";

const W_256K = 262_144;
const W_1M = 1_048_576;
const W_384K = 393_216;

describe("予約 R (docs/context-reduction-redesign.md §4.2。 2026-11-07 枠に比例)", () => {
  it("枠に比例し、 ティアの値を上限にする (1M の枠ではティアの上限そのもの)", () => {
    expect(computeContextBudget(W_1M, "T1").reserveTokens).toBe(71_680);
    expect(computeContextBudget(W_1M, "T2").reserveTokens).toBe(67_584);
    expect(computeContextBudget(W_1M, "T3").reserveTokens).toBe(17_408);
  });

  it("131K の T2 は O 16,384 / T 13,107 / M・S 3,932 で R 37,355 (以前の 67,584 は枠の 52%)", () => {
    const b = computeContextBudget(131_072, "T2");
    expect(b).toMatchObject({
      outputTokenLimit: 16_384,
      outputReserveTokens: 16_384,
      outputReserveSource: "limit",
      toolResultTotalTokens: 13_107,
      toolResultLimitTokens: 5_120,
      estimateMarginTokens: 3_932,
      reductionMarginTokens: 3_932,
      reserveTokens: 37_355,
      minimumReserveTokens: MIN_MAIN_OUTPUT_TOKENS + 13_107 + 3_932 + 3_932,
    });
  });

  it("どの枠でも R は枠の 35% まで、 枠が大きいほど割合は下がる", () => {
    let lastRatio = 1;
    for (const w of [16_384, 32_768, 65_536, 131_072, 262_144, W_1M]) {
      for (const tier of ["T1", "T2", "T3"] as const) {
        const b = computeContextBudget(w, tier);
        expect(b.reserveTokens, `${w} ${tier}`).toBeLessThanOrEqual(Math.floor(w * MAX_RESERVE_RATIO));
        expect(b.minimumReserveTokens).toBeLessThanOrEqual(b.reserveTokens);
        expect(b.toolResultLimitTokens).toBeLessThanOrEqual(b.toolResultTotalTokens);
      }
      const ratio = computeContextBudget(w, "T2").reserveTokens / w;
      expect(ratio).toBeLessThanOrEqual(lastRatio);
      lastRatio = ratio;
    }
  });

  it("合計 T は、 O の中で出せる最多の呼び出しの短い注記 (6 トークン) と長い注記 1 件が入る大きさを保つ (§4.3)", () => {
    for (const w of [32_768, 65_536, 131_072, 200_000, 262_144, W_1M]) {
      for (const tier of ["T1", "T2", "T3"] as const) {
        const b = computeContextBudget(w, tier);
        const maxCalls = Math.floor(b.outputTokenLimit / 9);
        expect(140 + (maxCalls - 1) * 6, `${w} ${tier}`).toBeLessThanOrEqual(b.toolResultTotalTokens);
      }
    }
  });

  it("出力の見込みは直近 3 件以上の実際の出力の最大 × 1.5 (O の上限と最低の出力で挟む)", () => {
    const w = 131_072;
    expect(computeContextBudget(w, "T2", { recentOutputTokens: [575, 9_748] }).outputReserveSource).toBe("limit");
    const b = computeContextBudget(w, "T2", { recentOutputTokens: [575, 9_748, 5_004] });
    expect(b.outputReserveSource).toBe("recent");
    expect(b.outputReserveTokens).toBe(14_622);
    expect(b.reserveTokens).toBe(14_622 + 13_107 + 3_932 + 3_932);
    expect(computeContextBudget(w, "T2", { recentOutputTokens: [10, 20, 30] }).outputReserveTokens).toBe(
      MIN_MAIN_OUTPUT_TOKENS,
    );
    expect(computeContextBudget(w, "T2", { recentOutputTokens: [50_000, 1, 1] }).outputReserveTokens).toBe(16_384);
  });

  it("ティアの上限 (T1・T2 とも O=32,768 / T=24,576、 K は 6 / 5 / 3)", () => {
    for (const tier of ["T1", "T2"] as const) {
      expect(TIER_CONTEXT_BUDGETS[tier].outputTokenLimit).toBe(32_768);
      expect(TIER_CONTEXT_BUDGETS[tier].toolResultTotalTokens).toBe(24_576);
    }
    expect(TIER_CONTEXT_BUDGETS.T1.keepRecentToolUses).toBe(6);
    expect(TIER_CONTEXT_BUDGETS.T2.keepRecentToolUses).toBe(5);
    expect(TIER_CONTEXT_BUDGETS.T3.keepRecentToolUses).toBe(3);
  });
});

describe("予約に届かなくても止めない (2026-11-07)", () => {
  // 実機 (2026-11-07 猫のモデル): 131K・T2 で、 整理後の P 64,010 + R 67,584 > 131,072 で止まった。 実際の出力の最大は 9,748
  const b = computeContextBudget(131_072, "T2");

  it("止めるのは P + 最低限の予約が枠を超えるときだけ", () => {
    expect(exceedsMinimumLimit(64_010, b)).toBe(false);
    const limit = 131_072 - b.minimumReserveTokens;
    expect(exceedsMinimumLimit(limit, b)).toBe(false);
    expect(exceedsMinimumLimit(limit + 1, b)).toBe(true);
  });

  it("本体の maxTokens は min(O の上限, W − P − T − M − S)", () => {
    expect(computeMainOutputTokens(30_000, b)).toBe(16_384);
    const p = 100_000;
    expect(computeMainOutputTokens(p, b)).toBe(131_072 - p - 13_107 - 3_932 - 3_932);
    // 最低限の予約が入る P なら、 最低の出力以上が残る
    expect(computeMainOutputTokens(131_072 - b.minimumReserveTokens, b)).toBe(MIN_MAIN_OUTPUT_TOKENS);
    expect(computeMainOutputTokens(200_000, b)).toBe(0);
  });
});

describe("§4.7 の数字 (T1、 G = 80,000。 256K は M が 7,864 で R = 71,352、 384K・1M は R = 71,680)", () => {
  const cases = [
    { w: W_256K, rule1: 190_792, rule2: 110_792 },
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
    // (262,144 − 71,352) ÷ 2 = 95,396
    expect(resolveRequestGrowth([300_000, 1_000, 1_000], budget)).toEqual({
      tokens: 95_396,
      source: "recent-max",
      capped: true,
      capTokens: 95_396,
    });
  });

  it("既定値も頭打ちを受ける (小さい枠)", () => {
    const small = computeContextBudget(200_000, "T1");
    // 200K の T1 は R = 57,000。 (200,000 − 57,000) ÷ 2 = 71,500 < 80,000
    expect(resolveRequestGrowth([], small)).toMatchObject({ tokens: 71_500, source: "default", capped: true });
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
  it("固定部分 + K × 1 件の上限 + 16,384 + 最低限の予約 ≤ W なら通る", () => {
    // T2・1M: K=5、 1 件の上限 5,120 トークン、 最低限の予約 = 4,096 + 24,576 + 4,096 + 6,144 = 38,912
    const fit = checkContextWindowFits({
      contextWindow: W_1M,
      tier: "T2",
      fixedTokens: 20_000,
    });
    expect(fit).toMatchObject({
      ok: true,
      contextWindow: W_1M,
      requiredTokens: 20_000 + 5 * 5_120 + MIN_CONVERSATION_TOKENS + 38_912,
      fixedTokens: 20_000,
      keepRecentToolUses: 5,
      toolResultLimitTokens: 5_120,
      recentToolResultTokens: 5 * 5_120,
      conversationTokens: 16_384,
      reserveTokens: 38_912,
    });
  });

  it("1 件の上限は切り詰めと同じトークン数 (最悪値に直さない。 2026-10-25 利用者の決定)", () => {
    expect(TIER_CONTEXT_BUDGETS.T1.toolResultLimitTokens).toBe(8_192);
    expect(TIER_CONTEXT_BUDGETS.T2.toolResultLimitTokens).toBe(5_120);
    expect(TIER_CONTEXT_BUDGETS.T3.toolResultLimitTokens).toBe(2_048);
    for (const tier of ["T1", "T2", "T3"] as const) {
      const fit = checkContextWindowFits({ contextWindow: W_1M, tier, fixedTokens: 0 });
      expect(fit.recentToolResultTokens).toBe(
        TIER_CONTEXT_BUDGETS[tier].keepRecentToolUses * TIER_CONTEXT_BUDGETS[tier].toolResultLimitTokens,
      );
    }
  });

  // 固定部分 約 11k (いまの system + ツール定義の実測に近い値) での必要量 (予約が枠に比例するので枠ごとに違う)
  it.each([
    // T1・200K: 11,000 + 6 × 8,000 + 16,384 + 最低限の予約 36,096 = 111,480
    ["T1", 200_000, 111_480],
    // T2・128K: 11,000 + 5 × 5,120 + 16,384 + 最低限の予約 24,576 = 77,560
    ["T2", 128_000, 77_560],
    // T3・64K: 11,000 + 3 × 2,048 + 16,384 + 最低限の予約 15,769 = 49,297
    ["T3", 65_536, 49_297],
  ] as const)("固定部分 11k のとき %s は %i の枠で起動できる (必要量 %i)", (tier, window, required) => {
    const fit = checkContextWindowFits({ contextWindow: window, tier, fixedTokens: 11_000 });
    expect(fit.requiredTokens).toBe(required);
    expect(fit.ok).toBe(true);
  });

  it("起動できる最小の枠ちょうどなら通り、 1 でも小さければ止めて、 その最小の枠を案内する", () => {
    const base = { tier: "T3" as const, fixedTokens: 5_000 };
    const min = findMinimumContextWindow("T3", 5_000);
    expect(checkContextWindowFits({ ...base, contextWindow: min }).ok).toBe(true);
    const tooSmall = checkContextWindowFits({ ...base, contextWindow: min - 1 });
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.minimumContextWindow).toBe(min);
    const message = formatContextWindowTooSmall(tooSmall, "qwen2.5-7b", "T3");
    expect(message).toContain("contextWindow が小さすぎます");
    expect(message).toContain(`サーバ側の枠を ${min.toLocaleString("en-US")} トークン以上`);
    expect(message).toContain("直近 3 回のツール結果");
  });

  it("固定部分 11k なら T1 55,446・T2 52,283・T3 46,919 の枠から起動できる (32K 枠は入らない)", () => {
    expect(findMinimumContextWindow("T1", 11_000)).toBe(55_446);
    expect(findMinimumContextWindow("T2", 11_000)).toBe(52_283);
    expect(findMinimumContextWindow("T3", 11_000)).toBe(46_919);
    expect(checkContextWindowFits({ contextWindow: 32_768, tier: "T3", fixedTokens: 11_000 }).ok).toBe(false);
  });
});

describe("利用者の入力の検査 (§4.3)", () => {
  it("入力 + 固定部分 + 最小限の保護部分 + R ≤ W なら受け付ける (境目ちょうどは通る)", () => {
    // T1、 200K 枠、 固定部分 11k: 起動時の必要量 111,480 → 入力は 88,520 まで
    const base = { contextWindow: 200_000, tier: "T1" as const, fixedTokens: 11_000 };
    const atLimit = checkUserInputFits({ ...base, inputTokens: 88_520 });
    expect(atLimit).toEqual({ ok: true, inputTokens: 88_520, maxInputTokens: 88_520, contextWindow: 200_000 });
    const over = checkUserInputFits({ ...base, inputTokens: 88_521 });
    expect(over.ok).toBe(false);
    expect(over.maxInputTokens).toBe(88_520);
  });

  it("断るときはファイルにして渡すよう案内する", () => {
    const fit = checkUserInputFits({ contextWindow: 65_536, tier: "T3", fixedTokens: 11_000, inputTokens: 20_000 });
    expect(fit.ok).toBe(false);
    const message = formatUserInputTooLarge(fit);
    expect(message).toContain("受け付けませんでした");
    expect(message).toContain("20,000");
    expect(message).toContain((65_536 - 49_297).toLocaleString("en-US"));
    expect(message).toContain("ファイルに保存");
  });

  it("枠が起動時の必要量より小さければ入れられる量は 0 (負にしない)", () => {
    const fit = checkUserInputFits({ contextWindow: 32_768, tier: "T3", fixedTokens: 11_000, inputTokens: 1 });
    expect(fit.maxInputTokens).toBe(0);
    expect(fit.ok).toBe(false);
  });
});
