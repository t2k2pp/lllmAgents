import { OpenAICompatProvider } from "./openai-compat.js";
import type { ChatParams, ChatWithToolsParams, ChatChunk } from "./base-provider.js";
import type { ModelInfo } from "../config/types.js";

interface AzureFoundryConfig {
  /** ホスト部のみ (例: https://my-resource.services.ai.azure.com) または完全URL */
  endpoint: string;
  /** Azure AI Foundry 上の model 名 (例: Kimi-K2-Instruct-0905) */
  model: string;
  apiKey: string;
  /** API バージョン (デフォルト: 2024-05-01-preview) */
  apiVersion?: string;
}

/**
 * Azure AI Foundry / Models as a Service 用プロバイダー。
 * Azure OpenAI Service と異なり、`/models/chat/completions` パスで
 * 複数モデル (Moonshot Kimi, Cohere, Mistral, Llama 等) にアクセスする。
 *
 * 仕様: https://learn.microsoft.com/azure/ai-foundry/model-inference/reference/reference-model-inference-api
 *   POST {endpoint}/models/chat/completions?api-version=2024-05-01-preview
 *   Header: api-key: <key>
 *   Body:   OpenAI互換 (model フィールドでルーティング)
 */
export class AzureFoundryProvider extends OpenAICompatProvider {
  private foundryConfig: AzureFoundryConfig;
  private requestHeaders: Record<string, string>;

  constructor(config: AzureFoundryConfig) {
    const baseUrl = AzureFoundryProvider.normalizeEndpoint(config.endpoint);
    super("azure-foundry", baseUrl);
    this.foundryConfig = config;
    this.requestHeaders = {
      "api-key": config.apiKey,
    };
  }

  /** ユーザーが完全URLを貼っても base (protocol+host) だけに正規化する */
  static normalizeEndpoint(input: string): string {
    const trimmed = input.trim().replace(/\/$/, "");
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host}`;
    } catch {
      // パース失敗時はそのまま返す（ユーザーに validate で弾かせる想定）
      return trimmed;
    }
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk, void, unknown> {
    yield* super.chat({ ...params, model: this.foundryConfig.model });
  }

  async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk, void, unknown> {
    yield* super.chatWithTools({ ...params, model: this.foundryConfig.model });
  }

  protected getChatUrl(): string {
    const apiVersion = this.foundryConfig.apiVersion ?? "2024-05-01-preview";
    return `${this.baseUrl}/models/chat/completions?api-version=${apiVersion}`;
  }

  protected async getRequestHeaders(): Promise<Record<string, string>> {
    return this.requestHeaders;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{
      name: this.foundryConfig.model,
      size: 0,
      contextLength: 4096,
      supportsVision: false,
      supportsFunctionCalling: true,
    }];
  }
}
