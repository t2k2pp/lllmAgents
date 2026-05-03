import type { ModelInfo, ModelDetail } from "../config/types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { httpGet, httpPost } from "../utils/http-client.js";
import { inferContextLength, FALLBACK_CONTEXT_WINDOW } from "./utils/context-length.js";

interface OllamaTag {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models: OllamaTag[];
}

interface OllamaShowResponse {
  modelfile?: string;
  parameters?: string;
  template?: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  model_info?: Record<string, unknown>;
}

const VISION_FAMILIES = ["llava", "bakllava", "moondream", "minicpm-v", "llama3.2-vision", "llama-3.2-vision", "qwen"];

export class OllamaProvider extends OpenAICompatProvider {
  constructor(baseUrl: string) {
    super("ollama", baseUrl);
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await httpGet(`${this.baseUrl}/api/tags`, 5000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await httpGet<OllamaTagsResponse>(`${this.baseUrl}/api/tags`);
    if (!res.ok || !res.data?.models) {
      return [];
    }

    const models: ModelInfo[] = [];
    for (const tag of res.data.models) {
      const family = tag.details?.family ?? "";
      const isVision = VISION_FAMILIES.some((v) => tag.name.toLowerCase().includes(v) || family.toLowerCase().includes(v));

      let contextLength = inferContextLength(tag.name) || FALLBACK_CONTEXT_WINDOW;
      try {
        const detail = await this.getModelDetail(tag.name);
        if (detail.contextLength > 0) contextLength = detail.contextLength;
      } catch {
        // モデル名ヒューリスティック / FALLBACK_CONTEXT_WINDOW を維持
      }

      models.push({
        name: tag.name,
        size: tag.size,
        contextLength,
        supportsVision: isVision,
        supportsFunctionCalling: true,
        digest: tag.digest,
        family,
      });
    }

    return models;
  }

  async getModelInfo(modelName: string): Promise<ModelDetail> {
    return this.getModelDetail(modelName);
  }

  private async getModelDetail(modelName: string): Promise<ModelDetail> {
    const res = await httpPost<OllamaShowResponse>(`${this.baseUrl}/api/show`, {
      name: modelName,
    });

    let contextLength = inferContextLength(modelName) || FALLBACK_CONTEXT_WINDOW;
    if (res.ok && res.data?.model_info) {
      // Look for context length in model_info keys
      for (const [key, value] of Object.entries(res.data.model_info)) {
        if (key.includes("context_length") && typeof value === "number") {
          contextLength = value;
          break;
        }
      }
    }

    // Also check parameters string for num_ctx
    if (res.ok && res.data?.parameters) {
      const match = res.data.parameters.match(/num_ctx\s+(\d+)/);
      if (match) {
        contextLength = parseInt(match[1], 10);
      }
    }

    const family = res.data?.details?.family ?? "";
    const isVision = VISION_FAMILIES.some(
      (v) => modelName.toLowerCase().includes(v) || family.toLowerCase().includes(v),
    );

    return {
      name: modelName,
      size: 0,
      contextLength,
      supportsVision: isVision,
      supportsFunctionCalling: true,
      parameterSize: res.data?.details?.parameter_size,
      quantizationLevel: res.data?.details?.quantization_level,
      format: res.data?.details?.format,
      family,
    };
  }

  async supportsVision(modelName: string): Promise<boolean> {
    const info = await this.getModelDetail(modelName);
    return info.supportsVision;
  }
}
