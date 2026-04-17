import { OpenAICompatProvider } from "./openai-compat.js";
import type { ChatParams, ChatWithToolsParams, ChatChunk } from "./base-provider.js";
import type { ModelInfo } from "../config/types.js";
interface AzureOpenAIConfig {
    endpoint: string;
    deploymentName: string;
    apiKey: string;
    apiVersion?: string;
}
export declare class AzureOpenAIProvider extends OpenAICompatProvider {
    private azureConfig;
    private requestHeaders;
    constructor(config: AzureOpenAIConfig);
    chat(params: ChatParams): AsyncGenerator<ChatChunk, void, unknown>;
    chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk, void, unknown>;
    protected getChatUrl(): string;
    protected getRequestHeaders(): Promise<Record<string, string>>;
    listModels(): Promise<ModelInfo[]>;
}
export {};
//# sourceMappingURL=azure-openai.d.ts.map