import { describe, it, expect } from "vitest";
import { inferContextLength } from "../../src/providers/utils/context-length.js";

describe("inferContextLength — モデル名から context length を推定", () => {
  it("Claude 系は 200K", () => {
    expect(inferContextLength("claude-opus-4-7")).toBe(200_000);
    expect(inferContextLength("claude-sonnet-4-6")).toBe(200_000);
    expect(inferContextLength("claude-haiku-4-5")).toBe(200_000);
  });

  it("GPT-5 / 4.1 系は 200K", () => {
    expect(inferContextLength("gpt-5.3-codex")).toBe(200_000);
    expect(inferContextLength("gpt-4.1")).toBe(200_000);
  });

  it("GPT-4o / o1 / o3 系は 128K", () => {
    expect(inferContextLength("gpt-4o")).toBe(128_000);
    expect(inferContextLength("gpt-4o-mini")).toBe(128_000);
  });

  it("Gemini 1.5 以降は 1M", () => {
    expect(inferContextLength("gemini-1.5-pro")).toBe(1_000_000);
    expect(inferContextLength("gemini-2.5-flash")).toBe(1_000_000);
  });

  it("Kimi K2 系は 256K (azure-foundry secondLLM ケース)", () => {
    expect(inferContextLength("Kimi-K2.6")).toBe(256_000);
    expect(inferContextLength("kimi-k2-instruct-0905")).toBe(256_000);
  });

  it("Llama 3.1 以降は 128K", () => {
    expect(inferContextLength("llama-3.1-70b")).toBe(128_000);
    expect(inferContextLength("llama-3.3-instruct")).toBe(128_000);
  });

  it("Qwen 2.5 / 3 は 128K", () => {
    expect(inferContextLength("qwen-2.5-72b")).toBe(128_000);
    expect(inferContextLength("qwen3-32b")).toBe(128_000);
  });

  it("DeepSeek は 128K", () => {
    expect(inferContextLength("deepseek-r1")).toBe(128_000);
  });

  it("未知モデルは推測値へ置換せず 0 を返す", () => {
    expect(inferContextLength("totally-unknown-model")).toBe(0);
    expect(inferContextLength("custom-finetune-v1")).toBe(0);
  });
});
