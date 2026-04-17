import { OpenAICompatProvider } from "./openai-compat.js";
export class AzureClaudeProvider extends OpenAICompatProvider {
    azureConfig;
    requestHeaders;
    constructor(config) {
        const baseUrl = `${config.endpoint.replace(/\/$/, "")}/openai/deployments/${config.deploymentName}`;
        super("azure-claude", baseUrl);
        this.azureConfig = config;
        this.requestHeaders = {
            "api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
        };
    }
    async *chat(params) {
        yield* super.chat({ ...params, model: this.azureConfig.deploymentName });
    }
    async *chatWithTools(params) {
        yield* super.chatWithTools({ ...params, model: this.azureConfig.deploymentName });
    }
    getChatUrl() {
        const apiVersion = this.azureConfig.apiVersion ?? "2024-02-15-preview";
        return `${this.baseUrl}/chat/completions?api-version=${apiVersion}`;
    }
    async getRequestHeaders() {
        return this.requestHeaders;
    }
    async listModels() {
        return [{
                name: this.azureConfig.deploymentName,
                size: 0,
                contextLength: 200000,
                supportsVision: false,
                supportsFunctionCalling: true
            }];
    }
}
//# sourceMappingURL=azure-claude.js.map