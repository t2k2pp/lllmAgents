import type { LLMEndpoint, ProviderType, SecondLLMEndpoint } from "../config/types.js";
import { isCloudProvider } from "../config/types.js";
import type { LLMProvider } from "./base-provider.js";
import { OllamaProvider } from "./ollama.js";
import { LMStudioProvider } from "./lmstudio.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { VLLMProvider } from "./vllm.js";
import { VertexAIProvider } from "./vertex-ai.js";
import { AzureOpenAIProvider } from "./azure-openai.js";
import { AzureClaudeProvider } from "./azure-claude.js";
import { CredentialVault } from "../security/credential-vault.js";

export function createProvider(endpoint: LLMEndpoint): LLMProvider {
  return createProviderByType(endpoint.providerType, endpoint.baseUrl);
}

export function createProviderByType(type: ProviderType, baseUrl: string): LLMProvider {
  switch (type) {
    case "ollama":
      return new OllamaProvider(baseUrl);
    case "lmstudio":
      return new LMStudioProvider(baseUrl);
    case "llamacpp":
      return new LlamaCppProvider(baseUrl);
    case "vllm":
      return new VLLMProvider(baseUrl);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

export function createSecondLLMProvider(endpoint: SecondLLMEndpoint, passphrase?: string): LLMProvider {
  if (isCloudProvider(endpoint.providerType)) {
    switch (endpoint.providerType) {
      case "vertex-ai":
        if (!endpoint.projectId || !endpoint.region) {
          throw new Error("Missing projectId or region for Vertex AI");
        }
        return new VertexAIProvider({
          projectId: endpoint.projectId,
          region: endpoint.region,
          model: endpoint.model,
        });

      case "azure-openai":
      case "azure-claude":
        if (!endpoint.endpoint || !endpoint.apiKey || !endpoint.deploymentName) {
          throw new Error(`Missing endpoint, apiKey, or deploymentName for ${endpoint.providerType}`);
        }
        const token = CredentialVault.resolve(endpoint.apiKey, passphrase);
        if (!token) {
          throw new Error("Failed to decipher or resolve API Key for Azure");
        }
        if (endpoint.providerType === "azure-openai") {
          return new AzureOpenAIProvider({
            endpoint: endpoint.endpoint,
            apiKey: token,
            deploymentName: endpoint.deploymentName,
          });
        } else {
          return new AzureClaudeProvider({
            endpoint: endpoint.endpoint,
            apiKey: token,
            deploymentName: endpoint.deploymentName,
          });
        }

      default:
        throw new Error(`Unknown cloud provider type: ${endpoint.providerType}`);
    }
  } else {
    // ローカルLLMの場合
    if (!endpoint.baseUrl) {
      throw new Error("Missing baseUrl for local LLM provider");
    }
    return createProviderByType(endpoint.providerType as ProviderType, endpoint.baseUrl);
  }
}

