import { describe, it, expect } from "vitest";
import {
  classifyTaskComplexity,
  recommendTier,
  explainRecommendation,
} from "../../src/agent/task-complexity.js";

describe("classifyTaskComplexity", () => {
  it("極短メッセージは simple-lookup (挨拶等)", () => {
    expect(classifyTaskComplexity("こんにちは")).toBe("simple-lookup");
    expect(classifyTaskComplexity("hi")).toBe("simple-lookup");
  });

  it("「教えて」「何?」 系は simple-lookup", () => {
    expect(classifyTaskComplexity("教えて、 typescript の型は何?")).toBe("simple-lookup");
    expect(classifyTaskComplexity("どこに main.py がある?")).toBe("simple-lookup");
    expect(classifyTaskComplexity("意味を要約して")).toBe("simple-lookup");
  });

  it("英語の調査系も simple-lookup", () => {
    expect(classifyTaskComplexity("What is TypeScript?")).toBe("simple-lookup");
    expect(classifyTaskComplexity("show me the latest log")).toBe("simple-lookup");
    expect(classifyTaskComplexity("explain the function")).toBe("simple-lookup");
  });

  it("「production」「設計書」 等は complex", () => {
    expect(classifyTaskComplexity("production 品質で実装してください")).toBe("complex");
    expect(classifyTaskComplexity("設計書を作成してから実装してください")).toBe("complex");
    expect(classifyTaskComplexity("Performance を最適化して")).toBe("complex");
  });

  it("長文 (300+ 字) は complex", () => {
    const longMsg = "X".repeat(350);
    expect(classifyTaskComplexity(longMsg)).toBe("complex");
  });

  it("通常の依頼は standard", () => {
    expect(classifyTaskComplexity("main.py を作成して、 hello world を出力するように")).toBe("standard");
    expect(classifyTaskComplexity("README.md を更新してください")).toBe("standard");
  });

  it("空文字列は standard (フォールバック)", () => {
    expect(classifyTaskComplexity("")).toBe("standard");
  });
});

describe("recommendTier", () => {
  it("complex × T3 → T1 推奨", () => {
    expect(recommendTier("complex", "T3")).toBe("T1");
  });

  it("complex × T2 → T1 推奨", () => {
    expect(recommendTier("complex", "T2")).toBe("T1");
  });

  it("complex × T1 → 推奨なし (既に最適)", () => {
    expect(recommendTier("complex", "T1")).toBeNull();
  });

  it("simple-lookup × T1 → T2 推奨 (コスト節約)", () => {
    expect(recommendTier("simple-lookup", "T1")).toBe("T2");
  });

  it("simple-lookup × T2 / T3 → 推奨なし (T3 まで落とすのは offer しない)", () => {
    expect(recommendTier("simple-lookup", "T2")).toBeNull();
    expect(recommendTier("simple-lookup", "T3")).toBeNull();
  });

  it("standard × どのティアでも推奨なし (現状維持が最適)", () => {
    expect(recommendTier("standard", "T1")).toBeNull();
    expect(recommendTier("standard", "T2")).toBeNull();
    expect(recommendTier("standard", "T3")).toBeNull();
  });
});

describe("explainRecommendation", () => {
  it("complex → T1 の説明にキーワードが含まれる", () => {
    const msg = explainRecommendation("complex", "T3", "T1");
    expect(msg).toContain("complex");
    expect(msg).toContain("T1");
  });

  it("simple-lookup → T2 の説明にコスト節約が含まれる", () => {
    const msg = explainRecommendation("simple-lookup", "T1", "T2");
    expect(msg).toContain("コスト");
  });
});
