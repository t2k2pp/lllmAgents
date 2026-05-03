import type { ModelInfo, ModelDetail } from "../config/types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { httpGet } from "../utils/http-client.js";
import { inferContextLength, FALLBACK_CONTEXT_WINDOW } from "./utils/context-length.js";

interface LlamaCppModel {
  id: string;
  object: string;
  meta?: {
    n_ctx_train?: number;
    n_params?: number;
  };
}

interface LlamaCppModelsResponse {
  data: LlamaCppModel[];
}

export class LlamaCppProvider extends OpenAICompatProvider {
  constructor(baseUrl: string) {
    super("llamacpp", baseUrl);
  }

  async testConnection(): Promise<boolean> {
    try {
      // llama.cpp has a /health endpoint
      const res = await httpGet(`${this.baseUrl}/health`, 5000);
      return res.ok;
    } catch {
      return super.testConnection();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Try native /models endpoint first for richer data
    try {
      const res = await httpGet<LlamaCppModelsResponse>(`${this.baseUrl}/models`);
      if (res.ok && res.data?.data) {
        return res.data.data.map((m) => ({
          name: m.id,
          size: m.meta?.n_params ?? 0,
          contextLength: m.meta?.n_ctx_train ?? (inferContextLength(m.id) || FALLBACK_CONTEXT_WINDOW),
          supportsVision: false,
          supportsFunctionCalling: true,
        }));
      }
    } catch {
      // Fall back to OpenAI-compatible endpoint
    }
    return super.listModels();
  }

  async getModelInfo(modelName: string): Promise<ModelDetail> {
    const models = await this.listModels();
    const found = models.find((m) => m.name === modelName);
    const ctxFromList = found?.contextLength ?? 0;
    const contextLength = ctxFromList > 0
      ? ctxFromList
      : (inferContextLength(modelName) || FALLBACK_CONTEXT_WINDOW);
    return {
      name: modelName,
      size: found?.size ?? 0,
      contextLength,
      supportsVision: false,
      supportsFunctionCalling: true,
    };
  }
}
