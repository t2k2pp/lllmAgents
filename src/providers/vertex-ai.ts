import { execSync } from "node:child_process";
import { OpenAICompatProvider } from "./openai-compat.js";

interface VertexEndpointConfig {
  projectId: string;
  region: string;
  model: string;
}

export class VertexAIProvider extends OpenAICompatProvider {
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private readonly TOKEN_LIFETIME_MS = 30 * 60 * 1000; // 30 mins buffer

  constructor(config: VertexEndpointConfig) {
    // Vertex AI returns OpenAI-compatible SSE structures for some models via Model Garden / Gemini REST APIs
    // However, the exact endpoint depends on the model.
    // For Gemini: https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:streamGenerateContent
    // For now we map to the base OpenAICompatProvider but we will override methods if need be.
    super("vertex-ai", `https://${config.region}-aiplatform.googleapis.com/v1beta1/projects/${config.projectId}/locations/${config.region}/endpoints/openapi`);
  }

  private getAccessToken(): string {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedToken.expiresAt) {
      return this.cachedToken.value;
    }

    try {
      const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
      this.cachedToken = {
        value: token,
        expiresAt: now + this.TOKEN_LIFETIME_MS,
      };
      return token;
    } catch (e) {
      throw new Error(`Failed to get Google Cloud access token: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  protected getChatUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  protected async getRequestHeaders(): Promise<Record<string, string>> {
    const token = this.getAccessToken();
    return {
      Authorization: `Bearer ${token}`
    };
  }
}
