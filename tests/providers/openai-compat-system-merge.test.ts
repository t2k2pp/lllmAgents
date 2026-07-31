import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat.js";
import * as httpClient from "../../src/utils/http-client.js";

/**
 * 回帰テスト: 複数の system メッセージを 1 通に統合してから送信すること。
 *
 * 背景 (2026-07-30):
 *   MessageHistory.getMessages() は prompt cache 最適化のため system prompt を
 *   stable/dynamic の 2 通の { role: "system" } メッセージに分けて返す
 *   (docs/prompt-cache-cost-reduction.md)。
 *   llama.cpp 上の Qwen 系モデルはサーバ側で公式 jinja チャットテンプレートを適用し、
 *   messages[0] だけを system として取り出して以降は loop_messages 扱いにするため、
 *   2 通目の system メッセージが `raise_exception('System message must be at the
 *   beginning.')` で 400 エラーになった (Gemma のテンプレートにはこの制約がなく再現しない)。
 *   OpenAI互換プロバイダ (llama.cpp/vLLM/LM Studio/Ollama等が共通利用) の送信直前で
 *   system メッセージを 1 通へ統合し、非 system メッセージの並びを保つことを保証する。
 */
describe("OpenAICompatProvider: system メッセージ統合", () => {
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

  async function drain(provider: OpenAICompatProvider, params: Parameters<OpenAICompatProvider["chat"]>[0]) {
    for await (const _ of provider.chat(params)) {
      // 副作用 (httpPostStream 呼び出し) のみが目的
    }
  }

  it("stable/dynamic の2通の system を1通に統合し、非system の並びを保つ", async () => {
    const provider = new OpenAICompatProvider("llamacpp", "https://example.test");
    await drain(provider, {
      model: "test-model",
      messages: [
        { role: "system", content: "stable base" },
        { role: "system", content: "dynamic: 2026-07-30" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      stream: true,
    });

    expect(capturedBody).toBeDefined();
    const messages = capturedBody?.messages as Array<{ role: string; content: unknown }>;
    const systemMessages = messages.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toBe("stable base\n\ndynamic: 2026-07-30");
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("system が1通のみなら内容を変えず送信する", async () => {
    const provider = new OpenAICompatProvider("llamacpp", "https://example.test");
    await drain(provider, {
      model: "test-model",
      messages: [
        { role: "system", content: "only system" },
        { role: "user", content: "hello" },
      ],
      stream: true,
    });

    const messages = capturedBody?.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toEqual([
      { role: "system", content: "only system" },
      { role: "user", content: "hello" },
    ]);
  });

  it("system が無い場合は何も追加しない", async () => {
    const provider = new OpenAICompatProvider("llamacpp", "https://example.test");
    await drain(provider, {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const messages = capturedBody?.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });
});
