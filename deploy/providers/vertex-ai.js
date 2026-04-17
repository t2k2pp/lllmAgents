import { execFileSync } from "node:child_process";
import { OpenAICompatProvider } from "./openai-compat.js";
export class VertexAIProvider extends OpenAICompatProvider {
    cachedToken = null;
    TOKEN_LIFETIME_MS = 30 * 60 * 1000; // 30 mins buffer
    constructor(config) {
        // Vertex AI returns OpenAI-compatible SSE structures for some models via Model Garden / Gemini REST APIs
        // However, the exact endpoint depends on the model.
        // For Gemini: https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:streamGenerateContent
        // For now we map to the base OpenAICompatProvider but we will override methods if need be.
        super("vertex-ai", `https://${config.region}-aiplatform.googleapis.com/v1beta1/projects/${config.projectId}/locations/${config.region}/endpoints/openapi`);
    }
    getAccessToken() {
        const now = Date.now();
        if (this.cachedToken && now < this.cachedToken.expiresAt) {
            return this.cachedToken.value;
        }
        try {
            // Security: Use execFileSync instead of execSync to prevent command injection
            const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
            this.cachedToken = {
                value: token,
                expiresAt: now + this.TOKEN_LIFETIME_MS,
            };
            return token;
        }
        catch (e) {
            throw new Error(`Failed to get Google Cloud access token: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    getChatUrl() {
        return `${this.baseUrl}/chat/completions`;
    }
    async getRequestHeaders() {
        const token = this.getAccessToken();
        return {
            Authorization: `Bearer ${token}`
        };
    }
}
//# sourceMappingURL=vertex-ai.js.map