import { OpenAICompatProvider } from "./openai-compat.js";
import { httpGet } from "../utils/http-client.js";
export class LlamaCppProvider extends OpenAICompatProvider {
    constructor(baseUrl) {
        super("llamacpp", baseUrl);
    }
    async testConnection() {
        try {
            // llama.cpp has a /health endpoint
            const res = await httpGet(`${this.baseUrl}/health`, 5000);
            return res.ok;
        }
        catch {
            return super.testConnection();
        }
    }
    async listModels() {
        // Try native /models endpoint first for richer data
        try {
            const res = await httpGet(`${this.baseUrl}/models`);
            if (res.ok && res.data?.data) {
                return res.data.data.map((m) => ({
                    name: m.id,
                    size: m.meta?.n_params ?? 0,
                    contextLength: m.meta?.n_ctx_train ?? 4096,
                    supportsVision: false,
                    supportsFunctionCalling: true,
                }));
            }
        }
        catch {
            // Fall back to OpenAI-compatible endpoint
        }
        return super.listModels();
    }
    async getModelInfo(modelName) {
        const models = await this.listModels();
        const found = models.find((m) => m.name === modelName);
        return {
            name: modelName,
            size: found?.size ?? 0,
            contextLength: found?.contextLength ?? 4096,
            supportsVision: false,
            supportsFunctionCalling: true,
        };
    }
}
//# sourceMappingURL=llamacpp.js.map