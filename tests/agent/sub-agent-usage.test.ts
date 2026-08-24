import { beforeEach, describe, expect, it } from "vitest";
import { SubAgentManager } from "../../src/agent/sub-agent.js";
import { globalTokenTracker } from "../../src/cost/token-tracker.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { ChatChunk, LLMProvider, TokenUsage } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

function providerWithUsage(
  usage: TokenUsage = { promptTokens: 100, completionTokens: 25, cachedTokens: 10 },
): LLMProvider {
  const gen = async function* (): AsyncGenerator<ChatChunk> {
    yield { type: "text", text: "作業は完了しました。" };
    yield {
      type: "done",
      finishReason: "stop",
      usage,
    };
  };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: gen,
    chatWithTools: gen,
    supportsVision: async () => false,
    chatWithVision: gen,
  } as unknown as LLMProvider;
}

function securityConfig(): SecurityConfig {
  return {
    allowedDirectories: [],
    blockedCommands: [],
    autoApproveTools: [],
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
  };
}

describe("SubAgent usage tracking", () => {
  beforeEach(() => globalTokenTracker.clearSession());

  it("サブエージェントの usage を main slot のコスト台帳へ記録する", async () => {
    const manager = new SubAgentManager(
      providerWithUsage(),
      "gpt-4o",
      new ToolRegistry(),
      new PermissionManager(securityConfig()),
    );

    const result = await manager.launchForeground("general-purpose", "usage test", "answer once");
    const records = globalTokenTracker.getRecords();

    expect(result.success).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "openai-compat",
      model: "gpt-4o",
      slot: "main",
      inputTokens: 100,
      outputTokens: 25,
      cachedTokens: 10,
    });
    expect(records[0].estimatedCostUsd).toBeGreaterThan(0);
  });

  it("Anthropic の cache creation が0件でも cache read を総入力へ含める", async () => {
    const manager = new SubAgentManager(
      providerWithUsage({
        promptTokens: 100,
        completionTokens: 25,
        cachedTokens: 10,
        cacheCreationTokens: 0,
      }),
      "claude-sonnet-4-6",
      new ToolRegistry(),
      new PermissionManager(securityConfig()),
    );

    await manager.launchForeground("general-purpose", "usage test", "answer once");

    expect(globalTokenTracker.getRecords()[0]).toMatchObject({
      inputTokens: 110,
      outputTokens: 25,
      cachedTokens: 10,
    });
  });
});
