import { describe, it, expect } from "vitest";
import { isStructurallyIncomplete } from "../../src/utils/incomplete-response.js";

describe("isStructurallyIncomplete", () => {
  it("空文字列は完了扱い", () => {
    expect(isStructurallyIncomplete("").incomplete).toBe(false);
    expect(isStructurallyIncomplete("   \n  ").incomplete).toBe(false);
  });

  it("文末記号で完了", () => {
    expect(isStructurallyIncomplete("処理を完了しました。").incomplete).toBe(false);
    expect(isStructurallyIncomplete("Done.").incomplete).toBe(false);
    expect(isStructurallyIncomplete("What is this?").incomplete).toBe(false);
    expect(isStructurallyIncomplete("素晴らしい！").incomplete).toBe(false);
  });

  it("閉じ括弧/引用で完了", () => {
    expect(isStructurallyIncomplete("結果(OK)").incomplete).toBe(false);
    expect(isStructurallyIncomplete("「はい」").incomplete).toBe(false);
    expect(isStructurallyIncomplete("[0, 1, 2]").incomplete).toBe(false);
  });

  it("コードフェンスで完了", () => {
    expect(isStructurallyIncomplete("```js\nconsole.log('x');\n```").incomplete).toBe(false);
  });

  it("未閉じコードブロックは不完全", () => {
    const r = isStructurallyIncomplete("```js\nconsole.log('x');");
    expect(r.incomplete).toBe(true);
    expect(r.reason).toContain("コードブロック");
  });

  it("未閉じマークダウンテーブル行は不完全", () => {
    const r = isStructurallyIncomplete("| Level | Size | Weight | Usage |\n| :--- | :--- | :");
    expect(r.incomplete).toBe(true);
    expect(r.reason).toContain("テーブル");
  });

  it("閉じたテーブル行は完了", () => {
    const r = isStructurallyIncomplete("| a | b |\n| c | d |");
    expect(r.incomplete).toBe(false);
  });

  it("単語/文の途中で切れている (英語プローズ)", () => {
    const r = isStructurallyIncomplete(
      "I have prepared a detailed **Design Specification Document** that will serve as the blueprint for",
    );
    expect(r.incomplete).toBe(true);
    expect(r.reason).toContain("単語");
  });

  it("単語/文の途中で切れている (日本語プローズ)", () => {
    const r = isStructurallyIncomplete("これから処理を");
    expect(r.incomplete).toBe(true);
  });

  it("節の途中で終端 (カンマ/コロン)", () => {
    expect(isStructurallyIncomplete("The steps are:").incomplete).toBe(true);
    expect(isStructurallyIncomplete("項目1、").incomplete).toBe(true);
  });

  it("未閉じ開き括弧", () => {
    expect(isStructurallyIncomplete("関数を定義 (").incomplete).toBe(true);
    expect(isStructurallyIncomplete("- [").incomplete).toBe(true);
  });

  it("水平線(---)やダッシュ末尾は完了扱い (保守的)", () => {
    expect(isStructurallyIncomplete("---").incomplete).toBe(false);
    expect(isStructurallyIncomplete("section ---").incomplete).toBe(false);
  });

  it("markdown checkbox 途中 '[x' は単語途中として検出", () => {
    const r = isStructurallyIncomplete("- [x");
    expect(r.incomplete).toBe(true);
  });
});
