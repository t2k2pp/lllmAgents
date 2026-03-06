import { OpenAICompatProvider } from "./openai-compat.js";
import type {
  ChatParams,
  ChatWithToolsParams,
  ChatChunk,
} from "./base-provider.js";
import type { ModelInfo } from "../config/types.js";

interface AzureClaudeConfig {
  endpoint: string;
  apiKey: string;
  deploymentName: string;
  apiVersion?: string;
}

export class AzureClaudeProvider extends OpenAICompatProvider {
  private azureConfig: AzureClaudeConfig;
  private requestHeaders: Record<string, string>;

  constructor(config: AzureClaudeConfig) {
    const baseUrl = `${config.endpoint.replace(/\/$/, "")}/openai/deployments/${config.deploymentName}`;
    super("azure-claude", baseUrl);
    this.azureConfig = config;
    this.requestHeaders = {
      "api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
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
      contextLength: 200000,
      supportsVision: false,
      supportsFunctionCalling: true
    }];
  }
}

