import type { LLMEndpoint, ProviderType } from "../config/types.js";
import type { LLMProvider } from "./base-provider.js";
import { OllamaProvider } from "./ollama.js";
import { LMStudioProvider } from "./lmstudio.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { VLLMProvider } from "./vllm.js";

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
