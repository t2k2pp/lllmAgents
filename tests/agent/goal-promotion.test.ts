import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  maybePromoteToGoal,
  extractAcceptanceCriteria,
  resetGoalPromotionState,
  type GoalPromotionAgent,
} from "../../src/agent/goal-promotion.js";
import { setInteractionBridge, clearInteractionBridges } from "../../src/agent/interaction-bridge-registry.js";
import type { GoalDefinition } from "../../src/agent/goal-slot.js";
import type { LLMProvider, ChatChunk } from "../../src/providers/base-provider.js";

// B-1: docs/goal-promotion-design.md

/** criteria JSON を返すフェイク provider */
function mkProvider(
  criteriaJson = '{"criteria": ["c1 が動作する", "c2 のテストがパスする", "c3 が存在する"]}',
): LLMProvider {
  return {
    providerType: "fake",
    async *chat(): AsyncGenerator<ChatChunk> {
      yield { type: "text", text: criteriaJson };
      yield { type: "done", finishReason: "stop" };
    },
  } as unknown as LLMProvider;
}

function mkAgent(
  provider = mkProvider(),
  inputRefusal: string | null = null,
): { agent: GoalPromotionAgent; entered: GoalDefinition[] } {
  const entered: GoalDefinition[] = [];
  const agent: GoalPromotionAgent = {
    getMode: () => "forward",
    getMetrics: () => ({ register: "unknown" }),
    getProvider: () => provider,
    getModel: () => "fake-model",
    enterGoalSeek: (g) => entered.push(g),
    checkUserInput: () => inputRefusal,
  };
  return { agent, entered };
}

// complex (production キーワード) + 明白なタスク (「を実装」が heuristic に合致)
const COMPLEX_TASK = "ユーザー管理 API を実装してください。production 品質で、認証・テスト・設計書まで含めること。";

beforeEach(() => {
  resetGoalPromotionState();
  clearInteractionBridges();
});

describe("extractAcceptanceCriteria", () => {
  it("JSON から criteria を抽出する", async () => {
    const criteria = await extractAcceptanceCriteria(mkProvider(), "m", "goal");
    expect(criteria).toEqual(["c1 が動作する", "c2 のテストがパスする", "c3 が存在する"]);
  });

  it("不正な応答では空配列 (throw しない)", async () => {
    const criteria = await extractAcceptanceCriteria(mkProvider("ごめんなさい、わかりません"), "m", "goal");
    expect(criteria).toEqual([]);
  });

  it("素の JSON 配列も受ける (思考オフ時に実測した出力形)", async () => {
    const criteria = await extractAcceptanceCriteria(
      mkProvider('[\n  "c1 が動作する",\n  "c2 が存在する"\n]'),
      "m",
      "goal",
    );
    expect(criteria).toEqual(["c1 が動作する", "c2 が存在する"]);
  });

  it("disableThinking=true で呼ぶ", async () => {
    const calls: Array<{ disableThinking?: boolean }> = [];
    const provider = {
      async *chat(params: { disableThinking?: boolean }): AsyncGenerator<ChatChunk> {
        calls.push(params);
        yield { type: "text", text: '{"criteria": ["c1"]}' };
        yield { type: "done", finishReason: "stop" };
      },
    } as unknown as LLMProvider;
    await extractAcceptanceCriteria(provider, "m", "goal");
    expect(calls[0].disableThinking).toBe(true);
  });
});

describe("maybePromoteToGoal (チャネル)", () => {
  it("complex タスク + ブリッジ承認で enterGoalSeek される", async () => {
    const { agent, entered } = mkAgent();
    const questions: string[] = [];
    setInteractionBridge("slack", {
      async askUser(req) {
        questions.push(req.question);
        return { answer: "Goal Seek で実行" };
      },
    });

    const promoted = await maybePromoteToGoal({
      input: COMPLEX_TASK,
      source: "slack",
      agent,
      enabled: true,
    });

    expect(promoted).toBe(true);
    expect(entered.length).toBe(1);
    expect(entered[0].statement).toBe(COMPLEX_TASK);
    expect(entered[0].acceptance_criteria.length).toBe(3);
    expect(questions[0]).toContain("c1 が動作する");
  });

  it("入力の検査に通らない (大きすぎる) 入力では、 脇の呼び出し (受け入れ条件の抽出) を送らず提案しない", async () => {
    const chat = vi.fn(async function* (): AsyncGenerator<ChatChunk> {
      yield { type: "text", text: '{"criteria": ["c1"]}' };
      yield { type: "done", finishReason: "stop" };
    });
    const { agent, entered } = mkAgent({ providerType: "fake", chat } as unknown as LLMProvider, "入力が大きすぎます");
    const askUser = vi.fn(async () => ({ answer: "Goal Seek で実行" }));
    setInteractionBridge("slack", { askUser });

    const promoted = await maybePromoteToGoal({ input: COMPLEX_TASK, source: "slack", agent, enabled: true });

    expect(promoted).toBe(false);
    expect(chat).not.toHaveBeenCalled();
    expect(askUser).not.toHaveBeenCalled();
    expect(entered).toHaveLength(0);
  });

  it("拒否されたら通常実行 + cooldown で再提案しない", async () => {
    const { agent, entered } = mkAgent();
    const askUser = vi.fn(async () => ({ answer: "通常実行" }));
    setInteractionBridge("slack", { askUser });

    const p1 = await maybePromoteToGoal({ input: COMPLEX_TASK, source: "slack", agent, enabled: true });
    expect(p1).toBe(false);
    expect(entered.length).toBe(0);
    expect(askUser).toHaveBeenCalledTimes(1);

    // cooldown 中は askUser 自体が呼ばれない
    const p2 = await maybePromoteToGoal({ input: COMPLEX_TASK, source: "slack", agent, enabled: true });
    expect(p2).toBe(false);
    expect(askUser).toHaveBeenCalledTimes(1);
  });

  it("standard 複雑度では提案しない", async () => {
    const { agent } = mkAgent();
    const askUser = vi.fn(async () => ({ answer: "Goal Seek で実行" }));
    setInteractionBridge("slack", { askUser });
    const promoted = await maybePromoteToGoal({
      input: "README のタイトルを修正して", // standard
      source: "slack",
      agent,
      enabled: true,
    });
    expect(promoted).toBe(false);
    expect(askUser).not.toHaveBeenCalled();
  });

  it("enabled=false なら何もしない", async () => {
    const { agent } = mkAgent();
    const askUser = vi.fn(async () => ({ answer: "Goal Seek で実行" }));
    setInteractionBridge("slack", { askUser });
    const promoted = await maybePromoteToGoal({ input: COMPLEX_TASK, source: "slack", agent, enabled: false });
    expect(promoted).toBe(false);
    expect(askUser).not.toHaveBeenCalled();
  });

  it("既に goal-seek 中は提案しない", async () => {
    const { agent } = mkAgent();
    (agent as { getMode: () => string }).getMode = () => "goal-seek";
    setInteractionBridge("slack", { askUser: vi.fn(async () => ({ answer: "Goal Seek で実行" })) });
    const promoted = await maybePromoteToGoal({ input: COMPLEX_TASK, source: "slack", agent, enabled: true });
    expect(promoted).toBe(false);
  });

  it("ブリッジ未登録のチャネルでは提案しない", async () => {
    const { agent } = mkAgent();
    const promoted = await maybePromoteToGoal({ input: COMPLEX_TASK, source: "discord", agent, enabled: true });
    expect(promoted).toBe(false);
  });

  it("criteria 抽出失敗時は黙って通常実行", async () => {
    const { agent, entered } = mkAgent(mkProvider("no json here"));
    const askUser = vi.fn(async () => ({ answer: "Goal Seek で実行" }));
    setInteractionBridge("slack", { askUser });
    const promoted = await maybePromoteToGoal({ input: COMPLEX_TASK, source: "slack", agent, enabled: true });
    expect(promoted).toBe(false);
    expect(entered.length).toBe(0);
    expect(askUser).not.toHaveBeenCalled();
  });
});

describe("maybePromoteToGoal (CLI)", () => {
  it("非 TTY では提案しない (パイプモードの自動テストを妨げない)", async () => {
    // vitest 実行環境は stdin が TTY ではない
    expect(process.stdin.isTTY).toBeFalsy();
    const { agent } = mkAgent();
    const promoted = await maybePromoteToGoal({ input: COMPLEX_TASK, source: "cli", agent, enabled: true });
    expect(promoted).toBe(false);
  });
});
