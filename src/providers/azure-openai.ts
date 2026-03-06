import { OpenAICompatProvider } from "./openai-compat.js";
import type { ChatParams, ChatWithToolsParams, ChatChunk } from "./base-provider.js";
import type { ModelInfo } from "../config/types.js";

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
    const baseUrl = `${config.endpoint.replace(/\/$/, "")}/openai/deployments/${config.deploymentName}`;
    super("azure-openai", baseUrl);
    this.azureConfig = config;
    this.requestHeaders = {
      "api-key": config.apiKey,
    };
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
    return [{
      name: this.azureConfig.deploymentName,
      size: 0,
      contextLength: 4096,
      supportsVision: false,
      supportsFunctionCalling: true
    }];
  }
}
