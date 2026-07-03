import { describe, it, expect } from "vitest";
import { AzureAnthropicProvider } from "../../src/providers/azure-anthropic.js";
import type { Message, ToolDefinition } from "../../src/providers/base-provider.js";

/**
 * プロンプトキャッシュ (docs/prompt-cache-cost-reduction.md) の buildRequestBody 検証。
 * buildRequestBody は private のためブラケットアクセスで叩く。
 */
function build(
  provider: AzureAnthropicProvider,
  messages: Message[],
  tools?: ToolDefinition[],
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (provider as any).buildRequestBody({ model: "claude-sonnet-4-6", messages, stream: true, tools });
}

const SYS_STABLE: Message = { role: "system", content: "STABLE BASE" };
const SYS_DYNAMIC: Message = { role: "system", content: "# Current datetime\n2026-06-18" };
const USER: Message = { role: "user", content: "こんにちは" };
const TOOLS: ToolDefinition[] = [
  { type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } },
];

describe("AzureAnthropicProvider buildRequestBody — プロンプトキャッシュ", () => {
  it("既定(ON): system はブロック配列で system[0] のみ cache_control を持つ", () => {
    const p = new AzureAnthropicProvider({ endpoint: "https://x.azure.com", apiKey: "k", model: "claude-sonnet-4-6" });
    const body = build(p, [SYS_STABLE, SYS_DYNAMIC, USER], TOOLS);
    const system = body.system as Array<Record<string, unknown>>;
    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(2);
    expect(system[0]).toMatchObject({ type: "text", text: "STABLE BASE", cache_control: { type: "ephemeral" } });
    // 動的サフィクスはキャッシュ境界より後ろ = cache_control なし
    expect(system[1].cache_control).toBeUndefined();
  });

  it("既定(ON): 最後のメッセージの最終ブロックにローリング cache_control が乗る", () => {
    const p = new AzureAnthropicProvider({ endpoint: "https://x.azure.com", apiKey: "k", model: "claude-sonnet-4-6" });
    const body = build(p, [SYS_STABLE, USER], TOOLS);
    const msgs = body.messages as Array<{ content: unknown }>;
    const last = msgs[msgs.length - 1];
    const blocks = last.content as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("ttl=1h を指定すると cache_control に ttl が乗る", () => {
    const p = new AzureAnthropicProvider({
      endpoint: "https://x.azure.com",
      apiKey: "k",
      model: "claude-sonnet-4-6",
      promptCache: { enabled: true, ttl: "1h" },
    });
    const body = build(p, [SYS_STABLE, USER]);
    const system = body.system as Array<Record<string, unknown>>;
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("OFF: system は文字列、 cache_control は一切付かない (従来挙動)", () => {
    const p = new AzureAnthropicProvider({
      endpoint: "https://x.azure.com",
      apiKey: "k",
      model: "claude-sonnet-4-6",
      promptCache: { enabled: false },
    });
    const body = build(p, [SYS_STABLE, SYS_DYNAMIC, USER], TOOLS);
    expect(typeof body.system).toBe("string");
    expect(body.system).toBe("STABLE BASE\n\n# Current datetime\n2026-06-18");
    const msgs = body.messages as Array<{ content: unknown }>;
    const last = msgs[msgs.length - 1];
    // 文字列のまま (ブロック化されていない)
    expect(typeof last.content).toBe("string");
  });
});
