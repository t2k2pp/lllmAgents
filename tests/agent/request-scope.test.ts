import { beforeEach, describe, expect, it, vi } from "vitest";

// docs/request-elaboration-design.md §5 — 依頼の範囲の読み取り原則がメイン/サブ全 tier に入り、
// 洗い出しの how が todo_append 初回に依頼ごと 1 度だけ遅延注入されることを確認する。

vi.mock("../../src/agent/project-context.js", () => ({
  loadProjectInstructions: vi.fn(() => ""),
  getGitInfo: vi.fn(() => ({ isGitRepo: false })),
}));
vi.mock("../../src/agent/memory.js", () => ({
  loadMemory: vi.fn(() => ""),
}));

const { buildSystemPrompt } = await import("../../src/agent/system-prompt.js");
const { buildSubAgentStrategyPrompt } = await import("../../src/agent/harness-intervention.js");
const { buildScopeRules, buildAcceptanceRules, buildCreativeRhythmRules } = await import(
  "../../src/agent/shared-principles.js"
);
const { getFirstUseGuide, resetToolGuides, resetPerRequestGuides } = await import("../../src/agent/tool-guides.js");

const TIERS = ["T1", "T2", "T3"] as const;
const ENV_MARK = "\n# Environment\n";

/** 各 tier の要となる言い回し (緩い正規表現ではなく固定で押さえる) */
const KEY_PHRASES: Record<(typeof TIERS)[number], string[]> = {
  T1: ["for standard+", '"Like X"', "dropping it silently is not"],
  T2: ["keep it proportional", '"Like X"', "dropping it silently is not", "At rough, keep the signature features"],
  T3: ["A small, exact request", '"Make something like X"', "ask_user which parts matter", "say it"],
};

describe("依頼の範囲の読み取り (buildScopeRules)", () => {
  it.each(TIERS)("%s: メインのシステムプロンプトに入る", (tier) => {
    const prompt = buildSystemPrompt(undefined, false, false, undefined, tier);
    expect(prompt).toContain(buildScopeRules(tier));
  });

  it.each(TIERS)("%s: サブエージェントの戦略プロンプトにも入る", (tier) => {
    expect(buildSubAgentStrategyPrompt(tier)).toContain(buildScopeRules(tier));
  });

  it.each(TIERS)("%s: ユーザーのデータを扱うアプリの土台 (空から始める・新規・保存・開く) を常駐で伝える", (tier) => {
    expect(buildScopeRules(tier)).toMatch(/start(ing)? empty, new, save,? (and )?open/);
  });

  it.each(TIERS)("%s: 要の言い回しを含む", (tier) => {
    const rules = buildScopeRules(tier);
    for (const phrase of KEY_PHRASES[tier]) expect(rules).toContain(phrase);
  });

  it("サブエージェントは委任された範囲を勝手に広げない", () => {
    expect(buildSubAgentStrategyPrompt("T2")).toContain("that list is the scope: do not add features");
  });

  it("T2: 冒頭宣言で含める/外すをユーザーの言語で書かせる", () => {
    const prompt = buildSystemPrompt(undefined, false, false, undefined, "T2");
    expect(prompt).toContain("in the user's language");
    expect(prompt).toContain("含める: A, B, C / 外す: D (理由)");
  });

  it("T3: 開始テンプレートに含める/外す行がある", () => {
    const prompt = buildSystemPrompt(undefined, false, false, undefined, "T3");
    expect(prompt).toContain("(4) Includes / leaves out");
  });

  it("T2/T3: ToDo の例は機能ベースで、 特定分野 (ゲーム) に寄せない", () => {
    expect(buildAcceptanceRules("T2")).toContain("user-visible features");
    for (const tier of ["T2", "T3"] as const) {
      expect(buildAcceptanceRules(tier)).toContain("export writes a CSV the user can open");
      expect(buildAcceptanceRules(tier)).not.toMatch(/shop|coin/);
    }
  });

  it.each(TIERS)("%s: 粗く作る = 範囲を削ることではないと明記", (tier) => {
    expect(buildCreativeRhythmRules(tier)).toMatch(/not about cutting scope|not fewer features/);
  });

  it("T2: 常駐部分 (# Environment より前) の肥大を防ぐ上限", () => {
    const prompt = buildSystemPrompt(undefined, false, false, undefined, "T2");
    // 2026-10-14 時点 約 7,700 字。 増やす場合は docs/system-prompt-redesign.md の原則に照らして見直すこと
    expect(prompt.indexOf(ENV_MARK)).toBeLessThanOrEqual(7900);
  });
});

describe("洗い出しガイド (todo_append 初回の遅延注入)", () => {
  beforeEach(() => resetToolGuides());

  it("1 つの依頼の中では 1 度だけ注入される", () => {
    const first = getFirstUseGuide("todo_append", "T2");
    expect(first).toContain("依頼の中身を洗い出す");
    expect(first).toContain("黙って外さない");
    // 道具・アプリの観点 (docs/env-info-and-app-basics.md §2.2)
    expect(first).toContain("初回は空の状態から始まる");
    expect(first).toContain("新規作成・保存・開く");
    expect(getFirstUseGuide("todo_append", "T2")).toBeNull();
  });

  it("新しい依頼が来たら再び注入される (他のガイドは 1 度きりのまま)", () => {
    getFirstUseGuide("todo_append", "T2");
    getFirstUseGuide("file_write", "T2");
    resetPerRequestGuides();
    expect(getFirstUseGuide("todo_append", "T2")).toContain("依頼の中身を洗い出す");
    expect(getFirstUseGuide("file_write", "T2")).toBeNull();
  });

  it("T3: few-shot 例と一緒に注入され、 例も機能ベースの項目を含む", () => {
    const first = getFirstUseGuide("todo_append", "T3") ?? "";
    expect(first).toContain("依頼の中身を洗い出す");
    expect(first).toContain("T3向け 例: todo_append");
    expect(first).toContain("顔が見分けられる");
  });
});
