import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../src/config/types.js";
import { checkModelNameArgs, checkModelNameAvailable } from "../../src/cli/model-name-check.js";

const opts = { usage: "/model <モデル名>", pickerCommand: "/model list" };
const model = (name: string): ModelInfo => ({
  name,
  size: 0,
  contextLength: 0,
  supportsVision: false,
  supportsFunctionCalling: true,
});

describe("checkModelNameArgs", () => {
  it("1 語なら通す", () => {
    expect(checkModelNameArgs(["qwen3:32b"], opts)).toEqual({ ok: true });
  });

  it("余分な引数があれば使い方エラー (例: /model url http://...)", () => {
    const r = checkModelNameArgs(["url", "http://192.168.1.10:8000"], opts);
    expect(r.ok).toBe(false);
    const text = !r.ok ? r.lines.join("\n") : "";
    expect(text).toContain("余分な引数");
    expect(text).toContain("/model <モデル名>");
    expect(text).toContain("/model list");
  });

  it("空なら使い方を返す", () => {
    expect(checkModelNameArgs([], opts).ok).toBe(false);
  });
});

describe("checkModelNameAvailable", () => {
  it("一覧にある名前なら通す", async () => {
    const r = await checkModelNameAvailable("a", async () => [model("a"), model("b")], opts);
    expect(r).toEqual({ ok: true });
  });

  it("一覧に無い名前は切り替えない (例: /model url)", async () => {
    const r = await checkModelNameAvailable("url", async () => [model("a"), model("b")], opts);
    expect(r.ok).toBe(false);
    const text = !r.ok ? r.lines.join("\n") : "";
    expect(text).toContain("url");
    expect(text).toContain("切り替えは行いませんでした");
    expect(text).toContain("a, b");
  });

  it("一覧が取得できない (サーバー停止) ときは黙って切り替えず再試行と picker を案内する", async () => {
    const r = await checkModelNameAvailable(
      "a",
      async () => {
        throw new Error("connect ECONNREFUSED");
      },
      opts,
    );
    expect(r.ok).toBe(false);
    const text = !r.ok ? r.lines.join("\n") : "";
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("再試行");
    expect(text).toContain("/model list");
  });

  it("空の一覧 (ローカル系サーバー停止時の戻り値) も取得できない扱い", async () => {
    const r = await checkModelNameAvailable("a", async () => [], opts);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.lines.join("\n")).toContain("再試行");
  });

  it("候補が多いときは先頭 10 件と残り件数を出す", async () => {
    const many = Array.from({ length: 13 }, (_, i) => model(`m${i}`));
    const r = await checkModelNameAvailable("x", async () => many, opts);
    expect(!r.ok && r.lines.join("\n")).toContain("ほか 3 件");
  });
});
