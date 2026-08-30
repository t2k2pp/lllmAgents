import { OpenAICompatProvider } from "./openai-compat.js";
import type { ChatParams, ChatWithToolsParams, ChatChunk } from "./base-provider.js";
import type { ModelInfo } from "../config/types.js";
import { inferContextLength } from "./utils/context-length.js";

interface AzureOpenAIConfig {
  endpoint: string; // e.g., https://my-resource.openai.azure.com
  deploymentName: string;
  apiKey: string;
  apiVersion?: string;
}

export class AzureOpenAIProvider extends OpenAICompatProvider {
  private azureConfig: AzureOpenAIConfig;
  private requestHeaders: Record<string, string>;

  constructor(config: AzureOpenAIConfig) {
    // 完全URL (例: https://x.openai.azure.com/openai/deployments/foo/chat/completions?api-version=...) を
    // 貼られても protocol+host だけに正規化する。 azure-anthropic 等と同じ挙動。
    const normalized = AzureOpenAIProvider.normalizeEndpoint(config.endpoint);
    const baseUrl = `${normalized}/openai/deployments/${config.deploymentName}`;
    super("azure-openai", baseUrl);
    this.azureConfig = { ...config, endpoint: normalized };
    this.requestHeaders = {
      "api-key": config.apiKey,
    };
  }

  /** 完全URLが貼られても base (protocol+host) だけに正規化する */
  static normalizeEndpoint(input: string): string {
    const trimmed = input.trim().replace(/\/$/, "");
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host}`;
    } catch {
      return trimmed;
    }
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk, void, unknown> {
    yield* super.chat({ ...params, model: this.azureConfig.deploymentName });
  }

  async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk, void, unknown> {
    yield* super.chatWithTools({ ...params, model: this.azureConfig.deploymentName });
  }

  protected getChatUrl(): string {
    const apiVersion = this.azureConfig.apiVersion ?? "2024-02-15-preview";
    return `${this.baseUrl}/chat/completions?api-version=${apiVersion}`;
  }

  protected async getRequestHeaders(): Promise<Record<string, string>> {
    return this.requestHeaders;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        name: this.azureConfig.deploymentName,
        size: 0,
        contextLength: inferContextLength(this.azureConfig.deploymentName),
        supportsVision: false,
        supportsFunctionCalling: true,
      },
    ];
  }
}
