import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AzureGPTProvider } from "../../src/providers/azure-gpt.js";
import { AzureOpenAIProvider } from "../../src/providers/azure-openai.js";
import * as httpClient from "../../src/utils/http-client.js";
import { resetSamplingCompatibilityWarnings } from "../../src/providers/openai-sampling-compat.js";

describe("OpenAI model sampling parameter compatibility", () => {
  let capturedBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    capturedBody = undefined;
    resetSamplingCompatibilityWarnings();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(httpClient, "httpPostStream").mockImplementation(async (_url, body) => {
      capturedBody = body as Record<string, unknown>;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
            ),
          );
          controller.close();
        },
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function drain(provider: AzureGPTProvider | AzureOpenAIProvider, model: string) {
    for await (const _chunk of provider.chat({
      model,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      repetition_penalty: 1.1,
    })) {
      // request body capture only
    }
  }

  it("Azure ResponsesのGPT-5.6では非対応temperature/top_pを送らず、明示的に通知する", async () => {
    const provider = new AzureGPTProvider({
      endpoint: "https://example.openai.azure.com",
      model: "gpt-5.6-luna",
      apiKey: "test-key",
    });

    await drain(provider, "gpt-5.6-luna");

    expect(capturedBody).not.toHaveProperty("temperature");
    expect(capturedBody).not.toHaveProperty("top_p");
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/gpt-5\.6-luna.*temperature.*top_p.*送信しません/));
  });

  it("Azure Chat Completionsのreasoning modelでも非対応parameterを送らない", async () => {
    const provider = new AzureOpenAIProvider({
      endpoint: "https://example.openai.azure.com",
      deploymentName: "gpt-5.2",
      apiKey: "test-key",
    });

    await drain(provider, "ignored-by-azure-provider");

    expect(capturedBody).not.toHaveProperty("temperature");
    expect(capturedBody).not.toHaveProperty("top_p");
    expect(capturedBody).not.toHaveProperty("top_k");
    expect(capturedBody).not.toHaveProperty("repetition_penalty");
  });

  it("Azure ResponsesのGPT-4.1では対応するtemperature/top_pを維持する", async () => {
    const provider = new AzureGPTProvider({
      endpoint: "https://example.openai.azure.com",
      model: "gpt-4.1",
      apiKey: "test-key",
    });

    await drain(provider, "gpt-4.1");

    expect(capturedBody?.temperature).toBe(0.2);
    expect(capturedBody?.top_p).toBe(0.9);
  });
});
