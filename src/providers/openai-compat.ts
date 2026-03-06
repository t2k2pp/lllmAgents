import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";
import type {
  LLMProvider,
  ChatParams,
  ChatWithToolsParams,
  VisionChatParams,
  ChatChunk,
  Message,
  ToolDefinition,
  TokenUsage,
} from "./base-provider.js";
import { httpGet, httpPostStream } from "../utils/http-client.js";

interface OpenAIModelResponse {
  data: Array<{ id: string; object: string }>;
}

interface SSEDelta {
  content?: string;
  /** Qwen3等のthinkingモデルが思考トークンを送信するフィールド */
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface SSEChoice {
  index: number;
  delta: SSEDelta;
  finish_reason: string | null;
}

interface SSEUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface SSEChunk {
  choices: SSEChoice[];
  usage?: SSEUsage;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly providerType: SecondLLMProviderType;
  protected baseUrl: string;

  constructor(providerType: SecondLLMProviderType, baseUrl: string) {
    this.providerType = providerType;
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  protected getModelsUrl(): string {
    return `${this.baseUrl}/v1/models`;
  }

  protected getChatUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  protected async getRequestHeaders(): Promise<Record<string, string>> {
    return {};
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await httpGet(this.getModelsUrl(), 5000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await httpGet<OpenAIModelResponse>(this.getModelsUrl());
    if (!res.ok || !res.data?.data) {
      return [];
    }
    return res.data.data.map((m) => ({
      name: m.id,
      size: 0,
      contextLength: 0,
      supportsVision: false,
      supportsFunctionCalling: true,
    }));
  }

  async getModelInfo(modelName: string): Promise<ModelDetail> {
    const models = await this.listModels();
    const found = models.find((m) => m.name === modelName);
    return {
      name: modelName,
      size: found?.size ?? 0,
      contextLength: found?.contextLength ?? 4096,
      supportsVision: found?.supportsVision ?? false,
      supportsFunctionCalling: found?.supportsFunctionCalling ?? true,
    };
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(params.model, params.messages, params.temperature, params.maxTokens, params.stream);
  }

  async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(
      params.model,
      params.messages,
      params.temperature,
      params.maxTokens,
      params.stream,
      params.tools,
      params.toolChoice,
    );
  }

  async supportsVision(_modelName: string): Promise<boolean> {
    return false;
  }

  async *chatWithVision(params: VisionChatParams): AsyncGenerator<ChatChunk> {
    yield* this.chat(params);
  }

  protected async *doChat(
    model: string,
    messages: Message[],
    temperature?: number,
    maxTokens?: number,
    _stream = true,
    tools?: ToolDefinition[],
    toolChoice?: ChatWithToolsParams["toolChoice"],
  ): AsyncGenerator<ChatChunk> {
    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => this.formatMessage(m)),
      stream: true,
      temperature: temperature ?? 0.7,
      // ストリーミングでusage情報を取得するためのオプション
      stream_options: { include_usage: true },
    };
    if (maxTokens) body.max_tokens = maxTokens;
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? "auto";
    }

    let streamBody: ReadableStream<Uint8Array>;
    try {
      const headers = await this.getRequestHeaders();
      streamBody = await httpPostStream(this.getChatUrl(), body, undefined, undefined, headers);
    } catch (e) {
      yield { type: "error", error: String(e) };
      return;
    }

    // Track partial tool calls across SSE chunks
    const partialToolCalls = new Map<number, { id: string; name: string; args: string }>();
    // Track usage from streaming response
    let lastUsage: TokenUsage | undefined;

    const reader = streamBody.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") {
            // Emit any completed tool calls
            for (const [, tc] of partialToolCalls) {
              yield {
                type: "tool_call",
                toolCall: {
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: tc.args },
                },
              };
            }
            yield { type: "done", finishReason: "stop", usage: lastUsage };
            return;
          }

          let chunk: SSEChunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }

          // ストリームからusage情報を抽出
          if (chunk.usage) {
            lastUsage = {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
            };
          }

          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;

            // Thinking content (Qwen3等のthinkingモデル)
            if (delta.reasoning_content) {
              yield { type: "thinking", text: delta.reasoning_content };
            }

            // Text content
            if (delta.content) {
              yield { type: "text", text: delta.content };
            }

            // Tool calls (streamed incrementally)
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!partialToolCalls.has(idx)) {
                  partialToolCalls.set(idx, { id: tc.id ?? "", name: "", args: "" });
                }
                const partial = partialToolCalls.get(idx)!;
                if (tc.id) partial.id = tc.id;
                if (tc.function?.name) partial.name += tc.function.name;
                if (tc.function?.arguments) partial.args += tc.function.arguments;
              }
            }

            // Finish reason
            if (choice.finish_reason) {
              if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") {
                for (const [, tc] of partialToolCalls) {
                  yield {
                    type: "tool_call",
                    toolCall: {
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: tc.args },
                    },
                  };
                }
                partialToolCalls.clear();
              }
              yield { type: "done", finishReason: choice.finish_reason, usage: lastUsage };
            }
          }
        }
      }
    } catch (e) {
      // アイドルタイムアウトやAbortによるストリーム切断をわかりやすいエラーに変換
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.name === "AbortError" || err.message.includes("abort")) {
        yield {
          type: "error",
          error: "ストリーム読み取りタイムアウト: LLMサーバーから一定時間データが受信できませんでした。サーバーの状態を確認してください。",
        };
      } else {
        yield { type: "error", error: err.message };
      }
      return;
    } finally {
      reader.releaseLock();
    }
  }

  protected formatMessage(msg: Message): Record<string, unknown> {
    const formatted: Record<string, unknown> = { role: msg.role };

    if (typeof msg.content === "string") {
      formatted.content = msg.content;
    } else {
      formatted.content = msg.content;
    }

    if (msg.tool_call_id) {
      formatted.tool_call_id = msg.tool_call_id;
    }
    if (msg.tool_calls) {
      formatted.tool_calls = msg.tool_calls;
    }

    return formatted;
  }
}
