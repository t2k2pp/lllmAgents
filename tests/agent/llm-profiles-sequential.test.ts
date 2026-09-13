import { describe, expect, it } from "vitest";
import { buildLLMProfiles } from "../../src/agent/llm-profiles.js";
import type { Config } from "../../src/config/types.js";

function config(mainUrl: string, secondUrl: string, parallel?: number, cloud = false): Config {
  return {
    mainLLM: { model: "main", providerType: cloud ? "azure-openai" : "ollama", baseUrl: mainUrl },
    secondLLM: {
      enabled: true,
      endpoint: { model: "second", providerType: cloud ? "azure-openai" : "ollama", baseUrl: secondUrl },
    },
    maxParallelTools: parallel,
  } as Config;
}

describe("LLM parallel recommendations", () => {
  it("既定設定は別ホストでも並列を提案しない", () => {
    expect(buildLLMProfiles(config("http://host-a:11434", "http://host-b:11434"), true).parallelCapable).toBe(false);
  });
  it("同一ホストの別ポートは並列向きと判定しない", () => {
    expect(buildLLMProfiles(config("http://localhost:11434", "http://127.0.0.1:8080", 3), true).parallelCapable).toBe(
      false,
    );
  });
  it("明示設定された異なるローカルホストだけ並列候補にする", () => {
    expect(buildLLMProfiles(config("http://host-a:11434", "http://host-b:11434", 3), true).parallelCapable).toBe(true);
  });
  it("AzureのURL違いから利用枠の独立を推定しない", () => {
    expect(
      buildLLMProfiles(config("https://a.openai.azure.com", "https://b.openai.azure.com", 3, true), true)
        .parallelCapable,
    ).toBe(false);
  });
});
