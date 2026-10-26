import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat.js";
import { collectResponse } from "../../src/providers/base-provider.js";
import * as httpClient from "../../src/utils/http-client.js";

describe("OpenAICompatProvider: finishReason 保持テスト", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("choice.finish_reason = length の後に [DONE] が来ても finishReason: length を維持する", async () => {
    const sseLines = [
      'data: {"choices":[{"index":0,"delta":{"content":"途中まで"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n',
      "data: [DONE]\n\n",
    ];

    vi.spyOn(httpClient, "httpPostStream").mockImplementation(async () => {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of sseLines) {
            controller.enqueue(new TextEncoder().encode(line));
          }
          controller.close();
        },
      });
    });

    const provider = new OpenAICompatProvider("openai-compat", "https://example.test");
    const response = await collectResponse(
      provider.chat({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
        stream: true,
      }),
    );

    expect(response.content).toBe("途中まで");
    expect(response.finishReason).toBe("length");
    expect(response.usage?.completionTokens).toBe(50);
  });

  it("finish_reason がチャンクにない場合のみ [DONE] で stop を既定値とする", async () => {
    const sseLines = [
      'data: {"choices":[{"index":0,"delta":{"content":"完了"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ];

    vi.spyOn(httpClient, "httpPostStream").mockImplementation(async () => {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of sseLines) {
            controller.enqueue(new TextEncoder().encode(line));
          }
          controller.close();
        },
      });
    });

    const provider = new OpenAICompatProvider("openai-compat", "https://example.test");
    const response = await collectResponse(
      provider.chat({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
        stream: true,
      }),
    );

    expect(response.content).toBe("完了");
    expect(response.finishReason).toBe("stop");
  });

  async function collectChunks(sseLines: string[]) {
    vi.spyOn(httpClient, "httpPostStream").mockImplementation(async () => {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of sseLines) {
            controller.enqueue(new TextEncoder().encode(line));
          }
          controller.close();
        },
      });
    });
    const provider = new OpenAICompatProvider("openai-compat", "https://example.test");
    const chunks = [];
    for await (const chunk of provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      stream: true,
    })) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it("finish_reason の後に usage が別のかたまりで来ても、 done は usage 付きで 1 回だけ出す (llama.cpp の返し方)", async () => {
    const chunks = await collectChunks([
      'data: {"choices":[{"index":0,"delta":{"content":"答え"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":96}}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const dones = chunks.filter((c) => c.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0].finishReason).toBe("stop");
    expect(dones[0].usage).toEqual({ promptTokens: 100, completionTokens: 5, cachedTokens: 96 });
  });

  it("[DONE] を送らずに閉じても、 終わりの理由を受け取っていれば done を 1 回出す", async () => {
    const chunks = await collectChunks([
      'data: {"choices":[{"index":0,"delta":{"content":"答え"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\n',
    ]);
    const dones = chunks.filter((c) => c.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0].usage?.promptTokens).toBe(10);
  });
});
