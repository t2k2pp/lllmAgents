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
  rules: { allow: [], deny: [], ask: [] },
};

describe("AgentLoop live model binding", () => {
  it("model 単体切替でも実行中 binding を更新し、未反映の誤警告を作らない", () => {
    const loop = new AgentLoop(provider, "qwen-old-7b", new ToolRegistry(), new PermissionManager(security), 128_000);
    loop.setLiveBinding({ providerType: "ollama", model: "qwen-old-7b", baseUrl: "http://localhost:11434" });

    loop.setModel("qwen-new-7b");

    expect(loop.getLiveBinding()?.model).toBe("qwen-new-7b");
    expect(loop.getLiveBinding()?.signature).toContain("|qwen-new-7b|");
    expect(loop.getLiveBinding()?.label).toContain("qwen-new-7b");
  });

  it("フルパス GGUF モデル (Qwen3.8-Flash-Next) を T2 として解決し初期化できる", () => {
    const loop = new AgentLoop(
      provider,
      "/home/osia/llama.cpp/models/Qwen3.8-Flash-Next/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf",
      new ToolRegistry(),
      new PermissionManager(security),
      262_144,
    );
    expect(loop.capability.tier).toBe("T2");
    expect(loop.capability.contextWindow).toBe(262_144);
  });

  describe("枠の検査 (docs/context-reduction-redesign.md §6.3)", () => {
    it("起動時: 整理しても次の呼び出しが入らない枠なら、 理由と必要量を示して止める", () => {
      expect(
        () => new AgentLoop(provider, "qwen-old-7b", new ToolRegistry(), new PermissionManager(security), 32_768),
      ).toThrow(/contextWindow が小さすぎます.*32,768 トークンに対して.*トークン要ります/);
    });

    it("枠の変更: 入らない値なら何も変えずに止める", () => {
      const loop = new AgentLoop(provider, "qwen-old-7b", new ToolRegistry(), new PermissionManager(security), 128_000);
      expect(() => loop.setContextWindow(16_384)).toThrow(/contextWindow が小さすぎます/);
      expect(loop.getContextWindow()).toBe(128_000);
      expect(loop.capability.contextWindow).toBe(128_000);
    });

    it("モデル切替: 新しいティアで入らなければ切り替えない", () => {
      const loop = new AgentLoop(provider, "qwen-old-7b", new ToolRegistry(), new PermissionManager(security), 100_000);
      // T2 は R = 67,584 + 直近 5 回 × 5,120 + 会話の最小限 16,384 = 109,568 (+ 固定部分) で 100,000 に入らない
      expect(() => loop.setModel("qwen3-32b")).toThrow(/ティア T2/);
      expect(loop.getModel()).toBe("qwen-old-7b");
      expect(loop.capability.tier).toBe("T3");
    });

    it("接続先の切替: endpoint の contextWindow と新しいモデルの組で確かめてから反映する", () => {
      const loop = new AgentLoop(provider, "qwen-old-7b", new ToolRegistry(), new PermissionManager(security), 100_000);
      const next = { providerType: "ollama" } as unknown as LLMProvider;
      expect(() =>
        loop.setProvider(next, "qwen3-32b", { providerType: "ollama", model: "qwen3-32b", contextWindow: 100_000 }),
      ).toThrow(/ティア T2/);
      expect(loop.getModel()).toBe("qwen-old-7b");

      loop.setProvider(next, "qwen3-32b", { providerType: "ollama", model: "qwen3-32b", contextWindow: 262_144 });
      expect(loop.getModel()).toBe("qwen3-32b");
      expect(loop.getContextWindow()).toBe(262_144);
      expect(loop.capability).toMatchObject({ tier: "T2", contextWindow: 262_144 });
    });
  });
});
