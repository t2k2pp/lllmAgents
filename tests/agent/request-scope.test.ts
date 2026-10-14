import { beforeEach, describe, expect, it, vi } from "vitest";

// docs/request-elaboration-design.md §5 — 依頼の範囲の読み取り原則がメイン/サブ全 tier に入り、
// 洗い出しの how が todo_append 初回に 1 度だけ遅延注入されることを確認する。

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
const { getFirstUseGuide, resetToolGuides } = await import("../../src/agent/tool-guides.js");

const TIERS = ["T1", "T2", "T3"] as const;

describe("依頼の範囲の読み取り (buildScopeRules)", () => {
  it.each(TIERS)("%s: メインのシステムプロンプトに入る", (tier) => {
    const prompt = buildSystemPrompt(undefined, false, false, undefined, tier);
    expect(prompt).toContain(buildScopeRules(tier));
  });

  it.each(TIERS)("%s: サブエージェントの戦略プロンプトにも入る", (tier) => {
    expect(buildSubAgentStrategyPrompt(tier)).toContain(buildScopeRules(tier));
  });

  it.each(TIERS)("%s: 既存作品を指す依頼と、黙って外さないことを扱う", (tier) => {
    const rules = buildScopeRules(tier);
    expect(rules).toMatch(/like X/);
    expect(rules).toMatch(/silent|say it/);
  });

  it("T2: 冒頭宣言で含める機能と外すものを書かせる", () => {
    const prompt = buildSystemPrompt(undefined, false, false, undefined, "T2");
    expect(prompt).toContain("Includes:");
    expect(prompt).toContain("Leaves out:");
  });

  it("T3: 開始テンプレートに含める/外す行がある", () => {
    const prompt = buildSystemPrompt(undefined, false, false, undefined, "T3");
    expect(prompt).toContain("(4) Includes:");
  });

  it("T2/T3: ToDo の例が工程だけでなく機能を含む", () => {
    expect(buildAcceptanceRules("T2")).toContain("user-visible features");
    expect(buildAcceptanceRules("T3")).toContain("the shop sells items for coins");
  });

  it.each(TIERS)("%s: 粗く作る = 範囲を削ることではないと明記", (tier) => {
    expect(buildCreativeRhythmRules(tier)).toMatch(/not about cutting scope|not fewer features/);
  });
});

describe("洗い出しガイド (todo_append 初回の遅延注入)", () => {
  beforeEach(() => resetToolGuides());

  it("初回の todo_append で 1 度だけ注入される", () => {
    const first = getFirstUseGuide("todo_append", "T2");
    expect(first).toContain("依頼の中身を洗い出す");
    expect(first).toContain("黙って外さない");
    expect(getFirstUseGuide("todo_append", "T2")).toBeNull();
  });

  it("T3 では few-shot 例と一緒に注入される", () => {
    const first = getFirstUseGuide("todo_append", "T3");
    expect(first).toContain("依頼の中身を洗い出す");
    expect(first).toContain("T3向け 例: todo_append");
  });
});
