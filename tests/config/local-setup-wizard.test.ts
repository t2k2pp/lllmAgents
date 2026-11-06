import { beforeEach, describe, expect, it, vi } from "vitest";

// 聞かれた質問 (name) と、 その時の既定値を記録し、 用意した答えを返す
const asked: Array<{ name: string; default: unknown }> = [];
let answers: Record<string, unknown> = {};

vi.mock("../../src/cli/prompt-gate.js", () => ({
  withPrompt: <T>(fn: () => Promise<T> | T) => fn(),
  inquirer: {
    prompt: async (qs: Array<{ name: string; default?: unknown }>) => {
      const q = qs[0];
      asked.push({ name: q.name, default: q.default });
      return { [q.name]: q.name in answers ? answers[q.name] : q.default };
    },
  },
}));

vi.mock("../../src/utils/spinner.js", () => {
  const s = { start: () => s, succeed: () => s, fail: () => s };
  return { createSpinner: () => s };
});

vi.mock("../../src/providers/provider-factory.js", () => ({
  createProviderByType: () => ({
    testConnection: async () => true,
    listModels: async () => [
      { name: "qwen-a", size: 0, contextLength: 131072, supportsVision: false },
      { name: "qwen-b", size: 0, contextLength: 32768, supportsVision: false },
    ],
  }),
}));

const { runLocalLLMSetup } = await import("../../src/config/setup-wizard.js");

describe("runLocalLLMSetup", () => {
  beforeEach(() => {
    asked.length = 0;
    answers = {};
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("種類を渡せば、 サーバーの種類をもう一度聞かない (/models Add new の二重の質問)", async () => {
    answers = { modelName: "qwen-a" };
    const r = await runLocalLLMSetup({ providerType: "llamacpp" });
    expect(asked.map((q) => q.name)).not.toContain("providerType");
    expect(r.endpoint.providerType).toBe("llamacpp");
    expect(r.endpoint.baseUrl).toBe("http://localhost:8080");
  });

  it("種類を渡さなければ聞く (初回 wizard)", async () => {
    answers = { providerType: "ollama", modelName: "qwen-a" };
    const r = await runLocalLLMSetup({});
    expect(asked[0].name).toBe("providerType");
    expect(r.endpoint.baseUrl).toBe("http://localhost:11434");
  });

  it("今の設定と違う種類を選んだ時は、 今の設定のポート・モデルを既定にしない", async () => {
    answers = { modelName: "qwen-a" };
    await runLocalLLMSetup({
      providerType: "llamacpp",
      current: { providerType: "ollama", baseUrl: "http://gpu-box:11434", model: "qwen-b", contextWindow: 8192 },
    });
    expect(asked.find((q) => q.name === "host")?.default).toBe("localhost");
    expect(asked.find((q) => q.name === "port")?.default).toBe(8080);
    expect(asked.find((q) => q.name === "modelName")?.default).toBeUndefined();
  });

  it("前の枠を既定にするのは同じモデルを選び直した時だけ", async () => {
    const current = {
      providerType: "llamacpp" as const,
      baseUrl: "http://localhost:8080",
      model: "qwen-b",
      contextWindow: 16000,
    };
    answers = { modelName: "qwen-b" };
    await runLocalLLMSetup({ current });
    expect(asked.find((q) => q.name === "contextWindowText")?.default).toBe("16000");

    asked.length = 0;
    answers = { modelName: "qwen-a" };
    const r = await runLocalLLMSetup({ current });
    expect(asked.find((q) => q.name === "contextWindowText")?.default).toBe("131072");
    expect(r.endpoint.contextWindow).toBe(131072);
  });
});
