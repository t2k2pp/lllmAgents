import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../../src/providers/base-provider.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { PermissionManager } from "../../src/security/permission-manager.js";

const PROJECT_MARKER = "SAFE-PROJECT-REINJECTION-MARKER";
const MEMORY_MARKER = "SAFE-MEMORY-REINJECTION-MARKER";
const CUSTOM_RULE_MARKER = "SAFE-CUSTOM-RULE-REINJECTION-MARKER";
const BUILTIN_RULE_MARKER = "SAFE-BUILTIN-RULE-MARKER";

vi.mock("../../src/agent/project-context.js", () => ({
  loadProjectInstructions: vi.fn(() => PROJECT_MARKER),
  getGitInfo: vi.fn(() => ({ isGitRepo: false })),
}));

vi.mock("../../src/agent/memory.js", () => ({
  loadMemory: vi.fn(() => MEMORY_MARKER),
}));

vi.mock("../../src/rules/rule-loader.js", () => ({
  RuleLoader: class {
    constructor(private readonly options: { includeCustomizations?: boolean } = {}) {}

    formatForSystemPrompt(): string {
      return this.options.includeCustomizations === false
        ? `\n# Rules\n${BUILTIN_RULE_MARKER}`
        : `\n# Rules\n${CUSTOM_RULE_MARKER}`;
    }
  },
}));

vi.mock("../../src/config/config-manager.js", () => ({
  loadConfig: vi.fn(() => ({
    context: {},
    checkpoints: { enabled: false },
  })),
}));

vi.mock("../../src/browser/browser-capability.js", () => ({
  getBrowserCapability: vi.fn(() => ({ ready: true })),
}));

vi.mock("../../src/config/model-resolver.js", () => ({
  listResolvableSlots: vi.fn(() => []),
}));

vi.mock("../../src/config/model-registry.js", () => ({
  listEntries: vi.fn(() => []),
}));

import { AgentLoop } from "../../src/agent/agent-loop.js";

function createSafeLoop(provider: LLMProvider): AgentLoop {
  return new AgentLoop(
    provider,
    "mock-model-7b",
    new ToolRegistry(),
    new PermissionManager({ autoApproveTools: [], allowedDirectories: [], rules: [] }),
    8192,
    0.8,
    undefined,
    [],
    "main",
    "safe-mode-test",
    false,
    3,
    false,
    {},
    false,
    null,
    undefined,
    true,
  );
}

function systemPrompt(loop: AgentLoop): string {
  const first = loop.getHistory().getMessages()[0];
  return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "");
}

function expectSafePrompt(loop: AgentLoop): void {
  const prompt = systemPrompt(loop);
  expect(prompt).not.toContain(PROJECT_MARKER);
  expect(prompt).not.toContain(MEMORY_MARKER);
  expect(prompt).not.toContain(CUSTOM_RULE_MARKER);
  expect(prompt).toContain(BUILTIN_RULE_MARKER);
}

describe("AgentLoop safe mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("system promptの全再構築経路でcustomizationを再注入しない", async () => {
    const provider = { chatWithTools: vi.fn() } as unknown as LLMProvider;
    const loop = createSafeLoop(provider);
    expectSafePrompt(loop);

    loop.updateLLMProfiles({ main: { model: "mock-model-7b", providerType: "vllm" } });
    expectSafePrompt(loop);

    loop.restoreSession({
      meta: { id: "restored-safe", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      messages: [],
    });
    expectSafePrompt(loop);

    loop.importConversation(null);
    expectSafePrompt(loop);

    await loop.applyInputCompression(true);
    expect(loop.getInputCompressionEnabled()).toBe(false);
    expect(provider.chatWithTools).not.toHaveBeenCalled();
    expectSafePrompt(loop);
  });
});
