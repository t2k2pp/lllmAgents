import type { ModelInfo, ModelDetail, ProviderType } from "../config/types.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
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
  temperature?: number;
  maxTokens?: number;
  stream: boolean;
}

export interface ChatWithToolsParams extends ChatParams {
  tools: ToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

export interface VisionChatParams extends ChatParams {
  // Messages already contain image content parts
}

export interface ChatChunk {
  type: "text" | "thinking" | "tool_call" | "done" | "error";
  text?: string;
  toolCall?: ToolCall;
  finishReason?: string;
  error?: string;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

export interface LLMProvider {
  readonly providerType: ProviderType;

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
