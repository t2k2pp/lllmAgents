import type { ModelInfo, ModelDetail } from "../config/types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { httpGet, httpPost } from "../utils/http-client.js";

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

const VISION_FAMILIES = ["llava", "bakllava", "moondream", "minicpm-v", "llama3.2-vision"];

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

      let contextLength = 4096;
      try {
        const detail = await this.getModelDetail(tag.name);
        contextLength = detail.contextLength;
      } catch {
        // Use default
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

    let contextLength = 4096;
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
