/**
 * Gufo プロバイダ (docs/gufo-provider.md) のテスト。
 * 応答の形は実機の Gufo (Qwen3.8 Flash Next) が返した物をそのまま使う。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const routes = new Map<string, { status: number; data?: unknown } | Error>();

vi.mock("../../src/utils/http-client.js", () => ({
  httpGet: async (url: string) => {
    const r = routes.get(url);
    if (r === undefined) return { ok: false, status: 404, data: "not found" };
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data };
  },
}));

const { GufoProvider } = await import("../../src/providers/gufo.js");
const { createProviderByType } = await import("../../src/providers/provider-factory.js");
const { DEFAULT_PORTS, LOCAL_PROVIDER_TYPES, PROVIDER_LABELS, isLocalProvider } = await import(
  "../../src/config/types.js"
);
const { sanitizeParsedConfig } = await import("../../src/config/config-schema.js");

const BASE = "http://gufo:9190";
const MODELS = {
  object: "list",
  data: [
    {
      id: "Qwen3.8 Flash Next",
      object: "model",
      owned_by: "gufo",
      context_length: 131072,
      architecture: { input_modalities: ["text"] },
    },
    {
      id: "vision-model",
      object: "model",
      context_length: 131072,
      architecture: { input_modalities: ["text", "image"] },
    },
  ],
};
const PROPS = { model_alias: "Qwen3.8 Flash Next", total_slots: 2, default_generation_settings: { n_ctx: 65536 } };

describe("GufoProvider", () => {
  beforeEach(() => {
    routes.clear();
    routes.set(`${BASE}/health`, { status: 200, data: { status: "ok" } });
    routes.set(`${BASE}/v1/models`, { status: 200, data: MODELS });
    routes.set(`${BASE}/props`, { status: 200, data: PROPS });
  });

  it("モデル一覧: 枠は /props の n_ctx (1 セッションの値)・画像対応は input_modalities", async () => {
    const models = await new GufoProvider(BASE).listModels();
    expect(models.map((m) => [m.name, m.contextLength, m.supportsVision])).toEqual([
      ["Qwen3.8 Flash Next", 65536, false],
      ["vision-model", 65536, true],
    ]);
  });

  it("接続の確認は /health だけ (落ちていればほかを試さず false)", async () => {
    expect(await new GufoProvider(BASE).testConnection()).toBe(true);
    routes.set(`${BASE}/health`, { status: 500 });
    expect(await new GufoProvider(BASE).testConnection()).toBe(false);
    routes.set(`${BASE}/health`, new Error("ECONNREFUSED"));
    expect(await new GufoProvider(BASE).testConnection()).toBe(false);
  });

  it("/props の n_ctx が無ければ推測せずに失敗する", async () => {
    routes.set(`${BASE}/props`, { status: 200, data: { model_alias: "x" } });
    await expect(new GufoProvider(BASE).listModels()).rejects.toThrow("default_generation_settings.n_ctx");
    routes.delete(`${BASE}/props`);
    await expect(new GufoProvider(BASE).listModels()).rejects.toThrow("/props");
  });

  it("読み込み中 (503) はそうと言って失敗する", async () => {
    routes.set(`${BASE}/v1/models`, { status: 503, data: { error: { code: "loading" } } });
    await expect(new GufoProvider(BASE).listModels()).rejects.toThrow("読み込み中");
  });

  it("/v1/models に data が無ければ失敗する (空の一覧にしない)", async () => {
    routes.set(`${BASE}/v1/models`, { status: 200, data: { object: "list" } });
    await expect(new GufoProvider(BASE).listModels()).rejects.toThrow("data");
  });

  it("getModelInfo: 無いモデルは推測せずに失敗する", async () => {
    const p = new GufoProvider(BASE);
    expect((await p.getModelInfo("Qwen3.8 Flash Next")).contextLength).toBe(65536);
    await expect(p.getModelInfo("no-such-model")).rejects.toThrow("no-such-model");
  });

  it("種類として登録されている (一覧・既定のポート・名前・工場・config の検査)", () => {
    expect(LOCAL_PROVIDER_TYPES).toContain("gufo");
    expect(isLocalProvider("gufo")).toBe(true);
    expect(isLocalProvider("anthropic")).toBe(false);
    expect(DEFAULT_PORTS.gufo).toBe(8080);
    expect(PROVIDER_LABELS.gufo).toBe("Gufo");
    expect(createProviderByType("gufo", BASE)).toBeInstanceOf(GufoProvider);
    const r = sanitizeParsedConfig({
      mainLLM: { providerType: "gufo", baseUrl: BASE, model: "m", contextWindow: 65536 },
    });
    expect(r.warnings).toEqual([]);
  });
});
