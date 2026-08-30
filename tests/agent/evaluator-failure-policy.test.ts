import { describe, expect, it, vi } from "vitest";
import { Evaluator } from "../../src/agent/evaluator.js";
import type { LLMProvider } from "../../src/providers/base-provider.js";
import type { SecondLLMManager } from "../../src/second-llm/second-llm-manager.js";

describe("Evaluator failure policy", () => {
  it("secondLLM未設定時にmainLLM自己評価へ置換しない", async () => {
    const mainChat = vi.fn();
    const evaluator = new Evaluator(null, { chat: mainChat } as unknown as LLMProvider, "main");

    expect(evaluator.isAvailable()).toBe(false);
    await expect(evaluator.evaluate({ filePaths: ["x.ts"], originalRequest: "review" })).rejects.toThrow(
      /requires an available secondLLM/,
    );
    expect(mainChat).not.toHaveBeenCalled();
  });

  it("secondLLMの非JSON応答を合格扱いしない", async () => {
    const manager = {
      isAvailable: () => true,
      runAsEvaluator: vi.fn().mockResolvedValue("looks good"),
    } as unknown as SecondLLMManager;
    const evaluator = new Evaluator(manager, {} as LLMProvider, "main");

    await expect(evaluator.evaluate({ filePaths: ["x.ts"], originalRequest: "review" })).rejects.toThrow(
      /result was not treated as passed/,
    );
  });
});
