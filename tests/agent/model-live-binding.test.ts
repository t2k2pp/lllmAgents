import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const provider = { providerType: "ollama" } as unknown as LLMProvider;
const security: SecurityConfig = {
  allowedDirectories: [],
  blockedCommands: [],
  autoApproveTools: [],
  requireApprovalTools: [],
  discordAutoApproveTools: [],
  slackAutoApproveTools: [],
  rules: { allow: [], deny: [], ask: [] },
};

describe("AgentLoop live model binding", () => {
  it("model 単体切替でも実行中 binding を更新し、未反映の誤警告を作らない", () => {
    const loop = new AgentLoop(provider, "qwen-old-7b", new ToolRegistry(), new PermissionManager(security), 8192, 0.8);
    loop.setLiveBinding({ providerType: "ollama", model: "qwen-old-7b", baseUrl: "http://localhost:11434" });

    loop.setModel("qwen-new-7b");

    expect(loop.getLiveBinding()?.model).toBe("qwen-new-7b");
    expect(loop.getLiveBinding()?.signature).toContain("|qwen-new-7b|");
    expect(loop.getLiveBinding()?.label).toContain("qwen-new-7b");
  });
});
