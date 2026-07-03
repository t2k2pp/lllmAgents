/**
 * Azure OpenAI Responses API ネイティブのプロバイダー。
 *
 * gpt-5-codex / gpt-5.x-codex / gpt-5 系など、 Microsoft Foundry 上で
 * Responses API 経由でしか呼び出せない (または推奨される) モデル向け。
 *
 * Chat Completions API (azure-openai) との違い:
 *   - URL:   /openai/v1/responses (api-version クエリ不要、 deployment 名もパスに不要)
 *   - 認証:   api-key ヘッダ (または Authorization: Bearer <Entra ID token>)
 *   - body:  messages → input、 max_tokens → max_output_tokens、 tools はフラット形式
 *   - SSE:   choices[].delta ではなく named event (response.output_text.delta 等)
 *
 * curl 例 (公式):
 *   curl -X POST https://YOUR-RESOURCE.openai.azure.com/openai/v1/responses \
 *     -H "Content-Type: application/json" \
 *     -H "api-key: $AZURE_OPENAI_API_KEY" \
 *     -d '{ "model": "gpt-5.3-codex", "input": "Hello" }'
 *
 * 詳細: docs/azure-gpt-provider.md
 */

import type {
  LLMProvider,
  ChatParams,
  ChatWithToolsParams,
  VisionChatParams,
  ChatChunk,
  Message,
  ToolDefinition,
  ToolCall,
} from "./base-provider.js";
import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";
import { httpPostStream } from "../utils/http-client.js";
import { getOpsLogger } from "../utils/ops-logger.js";

interface AzureGPTConfig {
  /** ホスト部のみ (例: https://x.openai.azure.com) または完全URL (内部で base に正規化) */
  endpoint: string;
  /** Azure 上の OpenAI モデル ID (例: gpt-5.3-codex)。 deployment 名と兼用可 */
  model: string;
  /** Azure リソースキー (api-key ヘッダで送信) */
  apiKey: string;
}

// Responses API の input 配列要素
type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant" | "system" | "developer"; content: ResponsesContentPart[] | string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

export class AzureGPTProvider implements LLMProvider {
  readonly providerType: SecondLLMProviderType = "azure-gpt";
  private config: AzureGPTConfig;
  private baseUrl: string;

  constructor(config: AzureGPTConfig) {
    this.config = config;
    this.baseUrl = AzureGPTProvider.normalizeEndpoint(config.endpoint);
  }

  /**
   * 完全URL (例: https://x.openai.azure.com/openai/v1/responses?...) または
   * ホスト URL (例: https://x.openai.azure.com) のどちらが入力されても、
   * 最終的に "https://x.openai.azure.com" の base 部分のみを返す。
   * その後 chatUrl() で /openai/v1/responses を結合する。
   */
  static normalizeEndpoint(input: string): string {
    const trimmed = input.trim().replace(/\/$/, "");
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host}`;
    } catch {
      return trimmed;
    }
  }

  private chatUrl(): string {
    return `${this.baseUrl}/openai/v1/responses`;
  }

  async testConnection(): Promise<boolean> {
    // Responses API は GET モデル一覧を提供しない。 最小ペイロードで POST し HTTP ステータスのみ確認
    try {
      const body = {
        model: this.config.model,
        input: "ping",
        max_output_tokens: 1,
      };
      const res = await fetch(this.chatUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      // 5xx 以外なら接続自体は OK (4xx は認証/モデル設定の問題で接続性ではない)
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        name: this.config.model,
        size: 0,
        contextLength: 200_000,
        supportsVision: true,
        supportsFunctionCalling: true,
      },
    ];
  }

  async getModelInfo(_modelName: string): Promise<ModelDetail> {
    return {
      name: this.config.model,
      size: 0,
      contextLength: 200_000,
      supportsVision: true,
      supportsFunctionCalling: true,
      format: "azure-openai-responses",
    };
  }

  async supportsVision(_modelName: string): Promise<boolean> {
    return true;
  }

  async *chatWithVision(params: VisionChatParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(params);
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(params);
  }

  async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    yield* this.doChat(params);
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "api-key": this.config.apiKey,
    };
  }

  /** OpenAI 形式の ChatParams を Responses API リクエストボディに変換 */
  private buildRequestBody(params: ChatParams & { tools?: ToolDefinition[] }): Record<string, unknown> {
    // 1. system は instructions に集約
    const systemMessages = params.messages.filter((m) => m.role === "system");
    const nonSystem = params.messages.filter((m) => m.role !== "system");
    const systemText = systemMessages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter((s) => s.length > 0)
      .join("\n\n");

    // 2. user/assistant/tool messages を Responses 形式の input 配列に変換
    const input = convertOpenAIMessagesToResponses(nonSystem);

    const body: Record<string, unknown> = {
      model: this.config.model,
      input,
      stream: params.stream,
    };
    if (systemText) body.instructions = systemText;
    if (params.maxTokens) body.max_output_tokens = params.maxTokens;
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.tools && params.tools.length > 0) {
      // Chat Completions の {type:"function", function:{name,...}} → Responses のフラット形式
      body.tools = params.tools.map((t) => ({
        type: "function",
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
    }

    return body;
  }

  /** ストリーミングチャット本体 */
  protected async *doChat(params: ChatParams & { tools?: ToolDefinition[] }): AsyncGenerator<ChatChunk> {
    const body = this.buildRequestBody({ ...params, stream: true });
    const url = this.chatUrl();

    if (process.env.LLM_DEBUG_HTTP) {
      console.error(
        `[LLM_DEBUG_HTTP] POST ${url}  model=${body.model}  input_items=${(body.input as unknown[])?.length}`,
      );
    }

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await httpPostStream(url, body, undefined, undefined, this.headers());
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      getOpsLogger().error("stream", `${this.providerType} request failed`, {
        provider: this.providerType,
        url,
        model: body.model,
        error: err.message,
        stack: err.stack,
      });
      yield {
        type: "error",
        error: `${err.message} [provider=${this.providerType} url=${url} model=${body.model}]`,
      };
      return;
    }

    yield* parseResponsesStream(stream, this.providerType, body.model as string);
  }
}

// ── ヘルパー: OpenAI ChatParams.messages → Responses API input 変換 ──

/**
 * OpenAI 形式 (system 除く) を Responses API input 配列に変換。
 * - role=user → {type:"message", role:"user", content:[{type:"input_text",text}|{type:"input_image",image_url}]}
 * - role=assistant (text) → {type:"message", role:"assistant", content:[{type:"output_text",text}]}
 * - role=assistant.tool_calls → 個別の {type:"function_call", call_id, name, arguments}
 * - role=tool → {type:"function_call_output", call_id, output}
 */
function convertOpenAIMessagesToResponses(messages: Message[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
      continue;
    }

    if (msg.role === "user") {
      const content = normalizeUserContent(msg.content);
      out.push({ type: "message", role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      // テキスト部
      const textPart =
        typeof msg.content === "string"
          ? msg.content
          : (msg.content ?? [])
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("");
      if (textPart && textPart.length > 0) {
        out.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: textPart }],
        });
      }

      // tool_calls → function_call items
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          out.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments ?? "{}",
          });
        }
      }
      continue;
    }
  }

  // 空入力は API がエラーにするので保護
  if (out.length === 0) {
    out.push({ type: "message", role: "user", content: [{ type: "input_text", text: "(empty)" }] });
  }
  return out;
}

function normalizeUserContent(
  content: string | { type: string; text?: string; image_url?: { url: string } }[],
): ResponsesContentPart[] | string {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  const parts: ResponsesContentPart[] = [];
  for (const p of content) {
    if (p.type === "text" && p.text) {
      parts.push({ type: "input_text", text: p.text });
    } else if (p.type === "image_url" && p.image_url?.url) {
      parts.push({ type: "input_image", image_url: p.image_url.url });
    }
  }
  return parts.length === 0 ? [{ type: "input_text", text: "(empty)" }] : parts;
}

// ── ストリーミングパーサ: Responses API SSE → ChatChunk ──────────────

interface PartialFunctionCall {
  callId: string;
  name: string;
  args: string;
  emitted: boolean;
}

/**
 * Azure OpenAI Responses API の SSE ストリームを ChatChunk に変換する。
 *
 * 主要イベント:
 * - response.created / response.in_progress: 無視
 * - response.output_item.added (item.type=function_call): tool 呼び出し開始
 *   → partialCalls[item.id] = { callId, name, args:"" }
 * - response.function_call_arguments.delta (item_id, delta): 引数 JSON の増分
 *   → partialCalls[item_id].args += delta
 * - response.output_item.done (item.type=function_call): tool 呼び出し完成
 *   → tool_call を yield (item.arguments を権威値として使用)
 * - response.output_text.delta (delta): テキスト増分
 *   → yield {type:"text", text:delta}
 * - response.output_text.done: 何もしない
 * - response.reasoning_summary_text.delta / response.reasoning.delta: thinking 増分 (codex/o系)
 * - response.completed (response.usage, response.status): 完了 + usage
 *   → yield {type:"done", usage, finishReason}
 * - response.failed / response.incomplete / error: エラー
 */
async function* parseResponsesStream(
  stream: ReadableStream<Uint8Array>,
  providerType: string = "azure-gpt",
  model: string = "",
): AsyncGenerator<ChatChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // item.id → 部分 function_call
  const partialCalls = new Map<string, PartialFunctionCall>();
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let stopStatus: string | undefined;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE のイベントは "event: <name>\ndata: <json>\n\n" 形式
      let eventEnd: number;
      while ((eventEnd = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);

        let eventName = "";
        let dataText = "";
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataText += line.slice(5).trim();
          }
        }
        if (!eventName || !dataText) continue;
        if (dataText === "[DONE]") continue;

        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(dataText);
        } catch {
          continue;
        }

        switch (eventName) {
          case "response.created":
          case "response.in_progress":
          case "response.queued":
            break;

          case "response.output_item.added": {
            const item = (data.item ?? {}) as {
              id?: string;
              type?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
            };
            if (item.type === "function_call" && item.id) {
              partialCalls.set(item.id, {
                callId: item.call_id ?? item.id,
                name: item.name ?? "",
                args: item.arguments ?? "",
                emitted: false,
              });
            }
            break;
          }

          case "response.function_call_arguments.delta": {
            const itemId = data.item_id as string | undefined;
            const delta = data.delta as string | undefined;
            if (itemId && delta) {
              const p = partialCalls.get(itemId);
              if (p) p.args += delta;
            }
            break;
          }

          case "response.function_call_arguments.done": {
            // arguments は item.done でも届くので、 ここでは権威値を更新するだけ
            const itemId = data.item_id as string | undefined;
            const argsFinal = data.arguments as string | undefined;
            if (itemId && argsFinal !== undefined) {
              const p = partialCalls.get(itemId);
              if (p) p.args = argsFinal;
            }
            break;
          }

          case "response.output_item.done": {
            const item = (data.item ?? {}) as {
              id?: string;
              type?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
            };
            if (item.type === "function_call" && item.id) {
              const p = partialCalls.get(item.id);
              const callId = item.call_id ?? p?.callId ?? item.id;
              const name = item.name ?? p?.name ?? "";
              const args = item.arguments ?? p?.args ?? "{}";
              const toolCall: ToolCall = {
                id: callId,
                type: "function",
                function: { name, arguments: args || "{}" },
              };
              yield { type: "tool_call", toolCall };
              if (p) p.emitted = true;
            }
            break;
          }

          case "response.output_text.delta": {
            const delta = data.delta as string | undefined;
            if (delta) yield { type: "text", text: delta };
            break;
          }

          case "response.output_text.done":
          case "response.content_part.added":
          case "response.content_part.done":
            break;

          // codex / o 系の reasoning ストリーム (将来的に出力される可能性)
          case "response.reasoning.delta":
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": {
            const delta = data.delta as string | undefined;
            if (delta) yield { type: "thinking", text: delta };
            break;
          }

          case "response.completed": {
            const resp = (data.response ?? {}) as {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                input_tokens_details?: { cached_tokens?: number };
              };
              status?: string;
              incomplete_details?: { reason?: string };
            };
            if (resp.usage) {
              promptTokens = resp.usage.input_tokens ?? promptTokens;
              completionTokens = resp.usage.output_tokens ?? completionTokens;
              // プロンプトキャッシュヒット分 (Responses API は input_tokens_details.cached_tokens で返す)。
              // input_tokens に含まれる「うちキャッシュ済み」 の内数。 コスト計算で割引単価を当てる。
              cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? cachedTokens;
            }
            stopStatus = resp.status ?? "completed";

            // 未 emit の partial tool call が残っていれば吐き出す (output_item.done が来なかったケースの保険)
            for (const p of partialCalls.values()) {
              if (!p.emitted && p.name) {
                yield {
                  type: "tool_call",
                  toolCall: {
                    id: p.callId,
                    type: "function",
                    function: { name: p.name, arguments: p.args || "{}" },
                  },
                };
                p.emitted = true;
              }
            }

            const hasToolCalls = Array.from(partialCalls.values()).some((p) => p.emitted);
            yield {
              type: "done",
              finishReason: mapResponsesStatus(stopStatus, hasToolCalls),
              usage: { promptTokens, completionTokens, cachedTokens },
            };
            break;
          }

          case "response.incomplete": {
            const resp = (data.response ?? {}) as {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                input_tokens_details?: { cached_tokens?: number };
              };
              incomplete_details?: { reason?: string };
            };
            if (resp.usage) {
              promptTokens = resp.usage.input_tokens ?? promptTokens;
              completionTokens = resp.usage.output_tokens ?? completionTokens;
              cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? cachedTokens;
            }
            const reason = resp.incomplete_details?.reason ?? "incomplete";
            yield {
              type: "done",
              finishReason: reason === "max_output_tokens" ? "length" : reason,
              usage: { promptTokens, completionTokens, cachedTokens },
            };
            break;
          }

          case "response.failed":
          case "error": {
            const resp = (data.response ?? data) as { error?: { code?: string; message?: string } };
            const err = resp.error;
            getOpsLogger().error("stream", "responses SSE error event", {
              provider: providerType,
              model,
              errorCode: err?.code,
              errorMessage: err?.message,
              raw: data,
            });
            yield {
              type: "error",
              error: `[azure-gpt] ${err?.code ?? "error"}: ${err?.message ?? JSON.stringify(data)}`,
            };
            break;
          }

          // それ以外 (response.refusal.* / response.audio.* 等) は無視
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function mapResponsesStatus(status: string | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
      return "error";
    default:
      return status ?? "stop";
  }
}
