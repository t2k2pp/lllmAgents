import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /**
   * 思考保全 (Phase 2 本実装): モデルが reasoning/thinking で返した内部思考。
   * 内部ストレージ専用フィールドで、 provider への送信時は MessageHistory.getMessages() が
   * content に inline 化して送る (provider に未対応フィールドを渡さないため)。
   * span 境界で破棄される (purgeEphemeralAtSpanEnd → clearAllThinking)。
   * docs/ephemeral-context-design.md §7 参照。
   */
  thinking?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatParams {
  model: string;
  messages: Message[];
  maxTokens?: number;
  stream: boolean;
  // サンプリングパラメータ: 設定値がある場合のみ送信。未指定ならサーバー側デフォルトに委ねる
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  /**
   * ユーザー中断 (Esc) を HTTP 層まで伝播させるためのシグナル。
   * これが無いと中断後も接続が残り、 llama.cpp 等のサーバが生成を続けて
   * 後続リクエストが詰まる (2026-06-12 に 557 秒の応答遅延として顕在化)。
   * 未対応 provider は無視してよい (従来挙動)。
   */
  signal?: AbortSignal;
}

export interface ChatWithToolsParams extends ChatParams {
  tools: ToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

export interface VisionChatParams extends ChatParams {
  // Messages already contain image content parts
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export interface ChatChunk {
  type: "text" | "thinking" | "tool_call" | "done" | "error";
  text?: string;
  toolCall?: ToolCall;
  finishReason?: string;
  error?: string;
  usage?: TokenUsage;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

export interface LLMProvider {
  readonly providerType: SecondLLMProviderType;

  testConnection(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  getModelInfo(modelName: string): Promise<ModelDetail>;

  chat(params: ChatParams): AsyncGenerator<ChatChunk>;
  chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk>;

  supportsVision(modelName: string): Promise<boolean>;
  chatWithVision(params: VisionChatParams): AsyncGenerator<ChatChunk>;
}

export async function collectResponse(gen: AsyncGenerator<ChatChunk>): Promise<ChatResponse> {
  let content = "";
  const toolCalls: ToolCall[] = [];
  let finishReason = "stop";

  for await (const chunk of gen) {
    switch (chunk.type) {
      case "text":
        content += chunk.text ?? "";
        break;
      case "tool_call":
        if (chunk.toolCall) {
          toolCalls.push(chunk.toolCall);
        }
        break;
      case "done":
        finishReason = chunk.finishReason ?? "stop";
        break;
      case "error":
        throw new Error(chunk.error ?? "Unknown LLM error");
    }
  }

  return { content, toolCalls, finishReason };
}
