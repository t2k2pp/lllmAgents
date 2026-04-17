import { OpenAICompatProvider } from "./openai-compat.js";
import type { ChatParams, ChatWithToolsParams, ChatChunk } from "./base-provider.js";
import type { ModelInfo } from "../config/types.js";
interface AzureClaudeConfig {
    endpoint: string;
    apiKey: string;
    deploymentName: string;
    apiVersion?: string;
}
export declare class AzureClaudeProvider extends OpenAICompatProvider {
    private azureConfig;
    private requestHeaders;
    constructor(config: AzureClaudeConfig);
    chat(params: ChatParams): AsyncGenerator<ChatChunk, void, unknown>;
    chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk, void, unknown>;
    protected getChatUrl(): string;
    protected getRequestHeaders(): Promise<Record<string, string>>;
    listModels(): Promise<ModelInfo[]>;
}
export {};
//# sourceMappingURL=azure-claude.d.ts.map