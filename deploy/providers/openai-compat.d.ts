import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";
import type { LLMProvider, ChatParams, ChatWithToolsParams, VisionChatParams, ChatChunk, Message, ToolDefinition } from "./base-provider.js";
export declare class OpenAICompatProvider implements LLMProvider {
    readonly providerType: SecondLLMProviderType;
    protected baseUrl: string;
    constructor(providerType: SecondLLMProviderType, baseUrl: string);
    protected getModelsUrl(): string;
    protected getChatUrl(): string;
    protected getRequestHeaders(): Promise<Record<string, string>>;
    testConnection(): Promise<boolean>;
    listModels(): Promise<ModelInfo[]>;
    getModelInfo(modelName: string): Promise<ModelDetail>;
    chat(params: ChatParams): AsyncGenerator<ChatChunk>;
    chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk>;
    supportsVision(_modelName: string): Promise<boolean>;
    chatWithVision(params: VisionChatParams): AsyncGenerator<ChatChunk>;
    protected doChat(params: ChatParams & {
        tools?: ToolDefinition[];
        toolChoice?: ChatWithToolsParams["toolChoice"];
    }): AsyncGenerator<ChatChunk>;
    protected formatMessage(msg: Message): Record<string, unknown>;
}
//# sourceMappingURL=openai-compat.d.ts.map