import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat.js";
import * as httpClient from "../../src/utils/http-client.js";

/**
 * 回帰テスト: contextWindow を max_tokens として送らないこと。
 *
 * 背景 (2026-05-04):
 *   agent-loop / second-llm-manager が `maxTokens: contextWindow` を渡しており、
 *   Azure AI Foundry (Kimi-K2 等) で `input + max_tokens > context_length` の 400 を誘発した。
 *   provider 側は params.maxTokens 未指定なら max_tokens フィールド自体を省略する仕様を保証する。
 *   (2026-10-25 以降、 本体呼び出しはティアの出力上限 O を必ず渡す。 contextWindow は渡さない。
 *   全 provider で載ることは max-tokens-all-providers.test.ts)
 */
describe("OpenAICompatProvider: max_tokens 送信ポリシー", () => {
  let capturedBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    capturedBody = undefined;
    vi.spyOn(httpClient, "httpPostStream").mockImplementation(async (_url, body) => {
      capturedBody = body as Record<string, unknown>;
      // 即座に [DONE] を返す空ストリームを返却
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

  async function drain(provider: OpenAICompatProvider, params: Parameters<OpenAICompatProvider["chat"]>[0]) {
    for await (const _ of provider.chat(params)) {
      // 副作用 (httpPostStream 呼び出し) のみが目的
    }
  }

  it("maxTokens 未指定なら body.max_tokens を含めない", async () => {
    const provider = new OpenAICompatProvider("openai-compat", "https://example.test");
    await drain(provider, {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    expect(capturedBody).toBeDefined();
    expect(capturedBody).not.toHaveProperty("max_tokens");
  });

  it("maxTokens を明示指定したらその値を送信する", async () => {
    const provider = new OpenAICompatProvider("openai-compat", "https://example.test");
    await drain(provider, {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      maxTokens: 1024,
    });

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.max_tokens).toBe(1024);
  });

  it("maxTokens=0 / undefined は送らない (省略扱い)", async () => {
    const provider = new OpenAICompatProvider("openai-compat", "https://example.test");
    await drain(provider, {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      maxTokens: 0,
    });

    expect(capturedBody).toBeDefined();
    expect(capturedBody).not.toHaveProperty("max_tokens");
  });
});

/** ChatParams.disableThinking の送信ポリシー (docs/context-forgetting.md §4.2) */
describe("OpenAICompatProvider: disableThinking 送信ポリシー", () => {
  let capturedBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    capturedBody = undefined;
    vi.spyOn(httpClient, "httpPostStream").mockImplementation(async (_url, body) => {
      capturedBody = body as Record<string, unknown>;
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

  async function send(providerType: string, disableThinking?: boolean) {
    const provider = new OpenAICompatProvider(providerType as never, "https://example.test");
    for await (const _ of provider.chat({
      model: "m",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      disableThinking,
    })) {
      // body の捕捉のみが目的
    }
  }

  it.each(["llamacpp", "vllm"])("%s には chat_template_kwargs.enable_thinking=false を送る", async (type) => {
    await send(type, true);
    expect(capturedBody?.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("未指定なら送らない", async () => {
    await send("llamacpp");
    expect(capturedBody).not.toHaveProperty("chat_template_kwargs");
  });

  it("対応外の provider には送らない (未知フィールドで 400 を避ける)", async () => {
    await send("openai-compat", true);
    expect(capturedBody).not.toHaveProperty("chat_template_kwargs");
  });
});
