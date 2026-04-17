import { OpenAICompatProvider } from "./openai-compat.js";
interface VertexEndpointConfig {
    projectId: string;
    region: string;
    model: string;
}
export declare class VertexAIProvider extends OpenAICompatProvider {
    private cachedToken;
    private readonly TOKEN_LIFETIME_MS;
    constructor(config: VertexEndpointConfig);
    private getAccessToken;
    protected getChatUrl(): string;
    protected getRequestHeaders(): Promise<Record<string, string>>;
}
export {};
//# sourceMappingURL=vertex-ai.d.ts.map