import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";
export interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: string | ContentPart[];
    tool_call_id?: string;
    tool_calls?: ToolCall[];
}
export interface ContentPart {
    type: "text" | "image_url";
    text?: string;
    image_url?: {
        url: string;
    };
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
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
}
export interface ChatWithToolsParams extends ChatParams {
    tools: ToolDefinition[];
    toolChoice?: "auto" | "none" | {
        type: "function";
        function: {
            name: string;
        };
    };
}
export interface VisionChatParams extends ChatParams {
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
export declare function collectResponse(gen: AsyncGenerator<ChatChunk>): Promise<ChatResponse>;
//# sourceMappingURL=base-provider.d.ts.map