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

interface LlamaCppProps {
  default_generation_settings?: {
    n_ctx?: number;
  };
  total_slots?: number;
  model_alias?: string;
  modalities?: {
    vision?: boolean;
    audio?: boolean;
  };
}

export class LlamaCppProvider extends OpenAICompatProvider {
  // /props は起動中サーバごとに固定なのでセッション内キャッシュ
  private propsCache: LlamaCppProps | null | undefined = undefined;

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

  private async getProps(): Promise<LlamaCppProps | null> {
    if (this.propsCache !== undefined) return this.propsCache;
    try {
      const res = await httpGet<LlamaCppProps>(`${this.baseUrl}/props`, 5000);
      this.propsCache = res.ok ? (res.data ?? null) : null;
    } catch {
      this.propsCache = null;
    }
    return this.propsCache;
  }

  async listModels(): Promise<ModelInfo[]> {
    const props = await this.getProps();
    const runtimeCtx = props?.default_generation_settings?.n_ctx ?? 0;
    const visionSupported = props?.modalities?.vision === true;

    // Try native /models endpoint first for richer data
    try {
      const res = await httpGet<LlamaCppModelsResponse>(`${this.baseUrl}/models`);
      if (res.ok && res.data?.data) {
        return res.data.data.map((m) => ({
          name: m.id,
          size: m.meta?.n_params ?? 0,
          // /props.n_ctx は --parallel で分割された per-slot 値で、実際に使える ctx を表す。
          // /models の n_ctx_train は学習時最大値で runtime と乖離するため /props を優先。
          contextLength:
            runtimeCtx > 0
              ? runtimeCtx
              : (m.meta?.n_ctx_train ?? (inferContextLength(m.id) || FALLBACK_CONTEXT_WINDOW)),
          supportsVision: visionSupported,
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
    const contextLength = ctxFromList > 0 ? ctxFromList : inferContextLength(modelName) || FALLBACK_CONTEXT_WINDOW;
    const props = await this.getProps();
    return {
      name: modelName,
      size: found?.size ?? 0,
      contextLength,
      supportsVision: found?.supportsVision ?? props?.modalities?.vision === true,
      supportsFunctionCalling: true,
    };
  }

  async supportsVision(modelName: string): Promise<boolean> {
    const info = await this.getModelInfo(modelName);
    return info.supportsVision;
  }
}
