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
});
