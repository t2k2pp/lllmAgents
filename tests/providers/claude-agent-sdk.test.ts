import { describe, it, expect } from "vitest";
import { ClaudeAgentSdkProvider } from "../../src/providers/claude-agent-sdk.js";

/**
 * claude-agent-sdk プロバイダの軽量スモークテスト。
 * 実 SDK 呼び出し (claude login 必須 + ネットワーク) は CI で再現しにくいため避け、
 * 構造的な保証 (型 / ファクトリ / metadata) のみテストする。
 * 実環境テストは user 手動で `npm start` → `/model setup claude-agent-sdk` 経由で検証。
 */
describe("ClaudeAgentSdkProvider — 構造的保証", () => {
  it("providerType と listModels が CLAUDE_MODELS を返す", async () => {
    const provider = new ClaudeAgentSdkProvider({ model: "claude-haiku-4-5" });
    expect(provider.providerType).toBe("claude-agent-sdk");

    const models = await provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.every((m) => m.supportsFunctionCalling)).toBe(true);
    expect(models.find((m) => m.name === "claude-opus-4-7")).toBeDefined();
  });

  it("getModelInfo は format=claude-agent-sdk を返す", async () => {
    const provider = new ClaudeAgentSdkProvider({ model: "claude-sonnet-4-6" });
    const info = await provider.getModelInfo("claude-sonnet-4-6");
    expect(info.format).toBe("claude-agent-sdk");
    expect(info.supportsFunctionCalling).toBe(true);
    expect(info.contextLength).toBe(1_000_000);
  });

  it("attachToolBridge は後付け登録できる (例外なし)", () => {
    const provider = new ClaudeAgentSdkProvider({ model: "claude-haiku-4-5" });
    // ダミーの ToolRegistry / ToolExecutor を渡して attach のみ確認
    const fakeRegistry = {
      getToolNames: () => [],
      get: () => undefined,
    } as never;
    const fakeExecutor = {} as never;
    expect(() => provider.attachToolBridge(fakeRegistry, fakeExecutor)).not.toThrow();
  });

  it("supportsVision は true (Claude 系は全て vision 対応想定)", async () => {
    const provider = new ClaudeAgentSdkProvider({ model: "claude-haiku-4-5" });
    expect(await provider.supportsVision("claude-haiku-4-5")).toBe(true);
  });
});
