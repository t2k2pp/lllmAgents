/**
 * Google AI Studio の Gemini API (`generativelanguage.googleapis.com`) を直接叩く Provider。
 *
 * Google が公式に提供する OpenAI 互換ルートを利用するため、
 *  - SSE 解析 / tool_calls の漸進的組み立て / vision (image_url) は `OpenAICompatProvider` を継承して再利用
 *  - 認証は Authorization: Bearer <GEMINI_API_KEY>
 *  - URL は `/v1beta/openai/chat/completions` 固定
 *  - listModels / getModelInfo は `GEMINI_MODELS` のハードコード一覧と動的取得 (失敗してもよい) をマージ
 *
 * `vertex-ai` が GCP プロジェクト + リージョン経由なのに対し、 こちらは API キー 1 個で
 * 使える軽量ルート (個人開発者向け)。 設計詳細は docs/gemini-aistudio-provider.md を参照。
 */

import { OpenAICompatProvider } from "./openai-compat.js";
import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";
import { GEMINI_MODELS } from "../config/types.js";

interface GeminiProviderConfig {
  /** API キー (ファクトリ側で env: / encrypted: 解決済みの平文を受け取る) */
  apiKey: string;
  /** モデル ID (例: gemini-2.5-flash) */
  model: string;
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

interface OpenAIModelResponse {
  data?: Array<{ id: string; object?: string }>;
}

export class GeminiProvider extends OpenAICompatProvider {
  readonly providerType: SecondLLMProviderType = "gemini";
  private readonly apiKey: string;

  constructor(config: GeminiProviderConfig) {
    super("gemini", GEMINI_API_BASE);
    this.apiKey = config.apiKey;
  }

  protected getChatUrl(): string {
    return `${this.baseUrl}/v1beta/openai/chat/completions`;
  }

  protected getModelsUrl(): string {
    return `${this.baseUrl}/v1beta/openai/models`;
  }

  protected async getRequestHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(this.getModelsUrl(), {
          headers: await this.getRequestHeaders(),
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const base: ModelInfo[] = GEMINI_MODELS.map((m) => ({
      name: m.id,
      size: 0,
      contextLength: m.contextWindow,
      supportsVision: m.supportsVision,
      supportsFunctionCalling: m.supportsTool,
    }));

    // 動的取得を試みる。 失敗した場合はハードコード一覧だけ返す (オフラインでも動かす)。
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let raw: OpenAIModelResponse | undefined;
      try {
        const res = await fetch(this.getModelsUrl(), {
          headers: await this.getRequestHeaders(),
          signal: controller.signal,
        });
        if (res.ok) raw = (await res.json()) as OpenAIModelResponse;
      } finally {
        clearTimeout(timer);
      }
      if (raw?.data) {
        const known = new Set(base.map((m) => m.name));
        for (const m of raw.data) {
          // id は "models/gemini-2.5-pro" の形式で返ることがあるため正規化
          const id = m.id.replace(/^models\//, "");
          if (known.has(id)) continue;
          // 未知モデル: 控えめなデフォルト (1M ctx, vision/tool true) を仮設定
          base.push({
            name: id,
            size: 0,
            contextLength: 1_048_576,
            supportsVision: true,
            supportsFunctionCalling: true,
          });
        }
      }
    } catch {
      // ignore — ハードコード一覧で返す
    }

    return base;
  }

  async getModelInfo(modelName: string): Promise<ModelDetail> {
    const found = GEMINI_MODELS.find((m) => m.id === modelName);
    const ctx = found?.contextWindow ?? 1_048_576;
    return {
      name: modelName,
      size: 0,
      contextLength: ctx,
      supportsVision: found?.supportsVision ?? true,
      supportsFunctionCalling: found?.supportsTool ?? true,
      format: "gemini-openai-compat",
    };
  }

  async supportsVision(modelName: string): Promise<boolean> {
    const found = GEMINI_MODELS.find((m) => m.id === modelName);
    return found?.supportsVision ?? true;
  }
}
