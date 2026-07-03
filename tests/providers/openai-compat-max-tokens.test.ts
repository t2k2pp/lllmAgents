import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat.js";
import * as httpClient from "../../src/utils/http-client.js";

/**
 * 回帰テスト: contextWindow を max_tokens として送らないこと。
 *
 * 背景 (2026-05-04):
 *   agent-loop / second-llm-manager が `maxTokens: contextWindow` を渡しており、
 *   Azure AI Foundry (Kimi-K2 等) で `input + max_tokens > context_length` の 400 を誘発した。
 *   呼び出し側で maxTokens を渡さない方針 + provider 側は params.maxTokens 未指定なら
 *   max_tokens フィールド自体を省略 (= サーバ既定 = 残コンテキスト全部) する仕様を保証する。
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
