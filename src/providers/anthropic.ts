/**
 * Anthropic Messages API (api.anthropic.com) を直接叩く Provider。
 *
 * AzureAnthropicProvider と同じ Messages API プロトコルなので、
 *  - メッセージ変換 / SSE 解析は親クラスを継承して再利用
 *  - エンドポイントは api.anthropic.com 固定 (パスは /v1/messages)
 *  - listModels() / getModelInfo() は CLAUDE_MODELS のハードコード一覧を返す
 * のみが本クラスの責務。
 *
 * 認証ヘッダ (x-api-key) と SSE 形式は Azure 経由と同一仕様。
 */

import { AzureAnthropicProvider } from "./azure-anthropic.js";
import type { ModelInfo, ModelDetail, SecondLLMProviderType } from "../config/types.js";
import { CLAUDE_MODELS } from "../config/types.js";

interface AnthropicProviderConfig {
  /** API キー (ファクトリ側で env: / encrypted: 解決済みの平文を受け取る) */
  apiKey: string;
  /** モデル ID (例: claude-sonnet-4-6) */
  model: string;
  /** デフォルト max_tokens。 ChatParams.maxTokens で上書き可 */
  defaultMaxTokens?: number;
  /** Anthropic API バージョン (デフォルト: 2023-06-01) */
  anthropicVersion?: string;
  /** プロンプトキャッシュ (コスト削減)。 docs/prompt-cache-cost-reduction.md。 既定 ON */
  promptCache?: { enabled?: boolean; ttl?: "5m" | "1h" };
}

const ANTHROPIC_API_BASE = "https://api.anthropic.com";

export class AnthropicProvider extends AzureAnthropicProvider {
  readonly providerType: SecondLLMProviderType = "anthropic";

  constructor(config: AnthropicProviderConfig) {
    super({
      endpoint: ANTHROPIC_API_BASE,
      apiKey: config.apiKey,
      model: config.model,
      anthropicVersion: config.anthropicVersion,
      defaultMaxTokens: config.defaultMaxTokens,
      promptCache: config.promptCache,
    });
  }

  protected getMessagesPath(): string {
    return "/v1/messages";
  }

  async listModels(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS.map((m) => ({
      name: m.id,
      size: 0,
      contextLength: m.contextWindow,
      supportsVision: true,
      supportsFunctionCalling: true,
    }));
  }

  async getModelInfo(modelName: string): Promise<ModelDetail> {
    const found = CLAUDE_MODELS.find((m) => m.id === modelName);
    const ctx = found?.contextWindow ?? 200_000;
    return {
      name: modelName,
      size: 0,
      contextLength: ctx,
      supportsVision: true,
      supportsFunctionCalling: true,
      format: "anthropic-messages-api",
    };
  }
}
