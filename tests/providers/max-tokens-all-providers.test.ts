import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatParams, LLMProvider } from "../../src/providers/base-provider.js";
import * as httpClient from "../../src/utils/http-client.js";

/**
 * 本体呼び出しの出力上限 O (ChatParams.maxTokens) が、 全 provider で実際にリクエストに載ること
 * (docs/context-reduction-redesign.md §4.2 / §13 タスク 4)。 欄の名前は provider ごとに違う:
 *   OpenAI 互換 = max_tokens、 Azure OpenAI の推論モデル = max_completion_tokens、
 *   Anthropic 系 = max_tokens、 Azure GPT (Responses API) = max_output_tokens、
 *   claude コマンド (claude-cli / claude-agent-sdk) = 環境変数 CLAUDE_CODE_MAX_OUTPUT_TOKENS。
 */

const spawnCalls: Array<{ args: string[]; options: { env?: NodeJS.ProcessEnv } }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((_bin: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ args, options });
      // すぐ終わる偽の子プロセス
      const proc = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => void;
      };
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => {};
      setImmediate(() => {
        proc.stdout.end();
        proc.stderr.end();
        proc.emit("close", 0);
        proc.emit("exit", 0);
      });
      return proc;
    }),
  };
});

const sdkQueries: Array<{ options: { env?: Record<string, string | undefined> } }> = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn((arg: { options: { env?: Record<string, string | undefined> } }) => {
    sdkQueries.push(arg);
    return (async function* () {})();
  }),
}));

const { OpenAICompatProvider } = await import("../../src/providers/openai-compat.js");
const { VLLMProvider } = await import("../../src/providers/vllm.js");
const { LlamaCppProvider } = await import("../../src/providers/llamacpp.js");
const { LMStudioProvider } = await import("../../src/providers/lmstudio.js");
const { OllamaProvider } = await import("../../src/providers/ollama.js");
const { GeminiProvider } = await import("../../src/providers/gemini.js");
const { VertexAIProvider } = await import("../../src/providers/vertex-ai.js");
const { AzureOpenAIProvider } = await import("../../src/providers/azure-openai.js");
const { AzureFoundryProvider } = await import("../../src/providers/azure-foundry.js");
const { AzureClaudeProvider } = await import("../../src/providers/azure-claude.js");
const { AzureAnthropicProvider } = await import("../../src/providers/azure-anthropic.js");
const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
const { AzureGPTProvider } = await import("../../src/providers/azure-gpt.js");
const { ClaudeCliProvider } = await import("../../src/providers/claude-cli.js");
const { ClaudeAgentSdkProvider } = await import("../../src/providers/claude-agent-sdk.js");

const O = 32_768;

function params(model: string): ChatParams {
  return { model, messages: [{ role: "user", content: "hello" }], stream: true, maxTokens: O };
}

async function drain(provider: LLMProvider, p: ChatParams): Promise<void> {
  for await (const _ of provider.chat(p)) {
    // 送信内容の捕捉だけが目的
  }
}

describe("出力上限がリクエストに載る (HTTP の provider)", () => {
  let body: Record<string, unknown> | undefined;

  beforeEach(() => {
    body = undefined;
    vi.spyOn(httpClient, "httpPostStream").mockImplementation(async (_url, b) => {
      body = b as Record<string, unknown>;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
    });
    // Vertex AI はアクセストークンを gcloud から取るので、 ヘッダの取得だけ差し替える
    vi.spyOn(
      VertexAIProvider.prototype as unknown as { getRequestHeaders: () => Promise<Record<string, string>> },
      "getRequestHeaders",
    ).mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const openAICompatible: Array<[string, () => LLMProvider, string]> = [
    ["openai-compat", () => new OpenAICompatProvider("openai-compat", "https://example.test"), "m"],
    ["vllm", () => new VLLMProvider("https://example.test"), "qwen"],
    ["llamacpp", () => new LlamaCppProvider("https://example.test"), "qwen"],
    ["lmstudio", () => new LMStudioProvider("https://example.test"), "qwen"],
    ["ollama", () => new OllamaProvider("https://example.test"), "qwen"],
    ["gemini", () => new GeminiProvider({ apiKey: "k", model: "gemini-2.5-pro" }), "gemini-2.5-pro"],
    [
      "vertex-ai",
      () => new VertexAIProvider({ projectId: "p", region: "us-central1", model: "gemini-2.5-pro" }),
      "gemini-2.5-pro",
    ],
    [
      "azure-openai (gpt-4o)",
      () => new AzureOpenAIProvider({ endpoint: "https://x.openai.azure.com", deploymentName: "gpt-4o", apiKey: "k" }),
      "gpt-4o",
    ],
    [
      "azure-foundry",
      () => new AzureFoundryProvider({ endpoint: "https://x.services.ai.azure.com", model: "Kimi-K2", apiKey: "k" }),
      "Kimi-K2",
    ],
    [
      "azure-claude",
      () =>
        new AzureClaudeProvider({ endpoint: "https://x.azure.com", deploymentName: "claude-sonnet-4-5", apiKey: "k" }),
      "claude-sonnet-4-5",
    ],
  ];

  it.each(openAICompatible)("%s は max_tokens を送る", async (_name, make, model) => {
    await drain(make(), params(model));
    expect(body?.max_tokens).toBe(O);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("azure-openai の推論モデル (gpt-5 等) は max_completion_tokens で送る (max_tokens は受け付けられない)", async () => {
    const provider = new AzureOpenAIProvider({
      endpoint: "https://x.openai.azure.com",
      deploymentName: "gpt-5.4",
      apiKey: "k",
    });
    await drain(provider, params("gpt-5.4"));
    expect(body?.max_completion_tokens).toBe(O);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it.each([
    [
      "azure-anthropic",
      () => new AzureAnthropicProvider({ endpoint: "https://x.azure.com", model: "claude-sonnet-4-5", apiKey: "k" }),
    ],
    ["anthropic", () => new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-4-5" })],
  ] as Array<[string, () => LLMProvider]>)("%s は max_tokens を送る", async (_name, make) => {
    await drain(make(), params("claude-sonnet-4-5"));
    expect(body?.max_tokens).toBe(O);
  });

  it("azure-gpt (Responses API) は max_output_tokens を送る", async () => {
    const provider = new AzureGPTProvider({ endpoint: "https://x.openai.azure.com", model: "gpt-5.4", apiKey: "k" });
    await drain(provider, params("gpt-5.4"));
    expect(body?.max_output_tokens).toBe(O);
  });
});

describe("先読みの出力上限 1 がリクエストに載る (先読みを送る自分のサーバの provider。 §9.2)", () => {
  let body: Record<string, unknown> | undefined;
  let url: string | undefined;

  beforeEach(() => {
    body = undefined;
    url = undefined;
    vi.spyOn(httpClient, "httpPostStream").mockImplementation(async (u, b) => {
      url = String(u);
      body = b as Record<string, unknown>;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["vllm", () => new VLLMProvider("https://example.test")],
    ["llamacpp", () => new LlamaCppProvider("https://example.test")],
    ["lmstudio", () => new LMStudioProvider("https://example.test")],
    ["ollama", () => new OllamaProvider("https://example.test")],
  ] as Array<
    [string, () => LLMProvider]
  >)("%s は /chat/completions に max_tokens: 1 で送る (n_predict は使わない)", async (_name, make) => {
    const { buildPrewarmRequest } = await import("../../src/agent/prewarm.js");
    const request = buildPrewarmRequest({ method: "chat", params: params("qwen") });
    await drain(make(), request.params);
    expect(body?.max_tokens).toBe(1);
    expect(body).not.toHaveProperty("n_predict");
    expect(url).toMatch(/\/chat\/completions$/);
  });
});

describe("出力上限が claude コマンドに渡る (claude-cli / claude-agent-sdk)", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    sdkQueries.length = 0;
  });

  it("claude-cli は CLAUDE_CODE_MAX_OUTPUT_TOKENS を子プロセスの環境変数に載せる", async () => {
    const provider = new ClaudeCliProvider({ model: "claude-haiku-4-5" });
    await drain(provider, params("claude-haiku-4-5"));
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(O));
  });

  it("claude-agent-sdk は query の env に CLAUDE_CODE_MAX_OUTPUT_TOKENS を載せる", async () => {
    const provider = new ClaudeAgentSdkProvider({ model: "claude-haiku-4-5" });
    await drain(provider, params("claude-haiku-4-5"));
    expect(sdkQueries).toHaveLength(1);
    expect(sdkQueries[0].options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(O));
  });

  it("maxTokens が無ければ環境変数を足さない (process.env のまま)", async () => {
    const provider = new ClaudeCliProvider({ model: "claude-haiku-4-5" });
    await drain(provider, { ...params("claude-haiku-4-5"), maxTokens: undefined });
    expect(spawnCalls[0].options.env).toBe(process.env);
  });
});
