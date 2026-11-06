import type { ModelDetail, ModelInfo } from "../config/types.js";
import { httpGet } from "../utils/http-client.js";
import { OpenAICompatProvider } from "./openai-compat.js";

/**
 * Gufo (https://github.com/gufo-org/gufo) の推論サーバー。 設計は docs/gufo-provider.md。
 *
 * 会話は OpenAI 互換 (/v1/chat/completions)。 モデル一覧は /v1/models、 1 セッションの枠は /props の n_ctx。
 * 取れない時は推測せずに失敗する (llama.cpp の実装のように n_ctx_train やモデル名から推測しない)。
 */

interface GufoModel {
  id: string;
  architecture?: { input_modalities?: string[] };
}

interface GufoModelsResponse {
  data?: GufoModel[];
}

interface GufoProps {
  default_generation_settings?: { n_ctx?: number };
}

export class GufoProvider extends OpenAICompatProvider {
  constructor(baseUrl: string) {
    super("gufo", baseUrl);
  }

  /** /health だけを見る (ほかの URL を試さない)。 */
  async testConnection(): Promise<boolean> {
    try {
      const res = await httpGet(`${this.baseUrl}/health`, 5000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = await this.getJson<GufoModelsResponse>("/v1/models");
    if (!Array.isArray(models.data)) {
      throw new Error(`Gufo の /v1/models に data がありません (${this.baseUrl})`);
    }
    const contextLength = await this.getSessionContext();
    return models.data.map((m) => ({
      name: m.id,
      size: 0,
      contextLength,
      supportsVision: m.architecture?.input_modalities?.includes("image") === true,
      supportsFunctionCalling: true,
    }));
  }

  async getModelInfo(modelName: string): Promise<ModelDetail> {
    const found = (await this.listModels()).find((m) => m.name === modelName);
    if (!found) {
      throw new Error(`Gufo (${this.baseUrl}) にモデル「${modelName}」がありません`);
    }
    return found;
  }

  async supportsVision(modelName: string): Promise<boolean> {
    return (await this.getModelInfo(modelName)).supportsVision;
  }

  /** /props の default_generation_settings.n_ctx (1 セッションで使える枠)。 */
  private async getSessionContext(): Promise<number> {
    const props = await this.getJson<GufoProps>("/props");
    const nCtx = props.default_generation_settings?.n_ctx;
    if (typeof nCtx !== "number" || !Number.isFinite(nCtx) || nCtx <= 0) {
      throw new Error(
        `Gufo の /props から 1 セッションの枠 (default_generation_settings.n_ctx) を取れません (${this.baseUrl})`,
      );
    }
    return nCtx;
  }

  private async getJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await httpGet<T>(url, 5000);
    if (res.status === 503) {
      throw new Error(`Gufo はモデルを読み込み中です (${url} が 503)。 読み込みが終わってからもう一度試してください`);
    }
    if (!res.ok || res.data == null) {
      throw new Error(`Gufo の ${path} を取れません (${url} が ${res.status})`);
    }
    return res.data;
  }
}
