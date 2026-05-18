import type { LLMEndpoint, ProviderType, SecondLLMEndpoint } from "../config/types.js";
import { isCloudProvider } from "../config/types.js";
import type { LLMProvider } from "./base-provider.js";
import { OllamaProvider } from "./ollama.js";
import { LMStudioProvider } from "./lmstudio.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { VLLMProvider } from "./vllm.js";
import { VertexAIProvider } from "./vertex-ai.js";
import { AzureOpenAIProvider } from "./azure-openai.js";
import { AzureGPTProvider } from "./azure-gpt.js";
import { AzureClaudeProvider } from "./azure-claude.js";
import { AzureFoundryProvider } from "./azure-foundry.js";
import { AzureAnthropicProvider } from "./azure-anthropic.js";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { CredentialVault } from "../security/credential-vault.js";

/**
 * LLMEndpoint / SecondLLMEndpoint 共通の Provider ファクトリ。
 * クラウド系 (vertex-ai, azure-*) は apiKey の復号 (env: / encrypted: / 平文) も担う。
 */
function createProviderFromEndpoint(
  endpoint: LLMEndpoint | SecondLLMEndpoint,
  passphrase?: string,
): LLMProvider {
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
      case "azure-claude": {
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
      }

      case "azure-foundry": {
        if (!endpoint.endpoint || !endpoint.apiKey || !endpoint.model) {
          throw new Error("Missing endpoint, apiKey, or model for azure-foundry");
        }
        const foundryToken = CredentialVault.resolve(endpoint.apiKey, passphrase);
        if (!foundryToken) {
          throw new Error("Failed to decipher or resolve API Key for Azure Foundry");
        }
        return new AzureFoundryProvider({
          endpoint: endpoint.endpoint,
          apiKey: foundryToken,
          model: endpoint.model,
        });
      }

      case "azure-anthropic": {
        if (!endpoint.endpoint || !endpoint.apiKey || !endpoint.model) {
          throw new Error("Missing endpoint, apiKey, or model for azure-anthropic");
        }
        const anthToken = CredentialVault.resolve(endpoint.apiKey, passphrase);
        if (!anthToken) {
          throw new Error("Failed to decipher or resolve API Key for Azure Anthropic");
        }
        return new AzureAnthropicProvider({
          endpoint: endpoint.endpoint,
          apiKey: anthToken,
          model: endpoint.model,
        });
      }

      case "azure-gpt": {
        if (!endpoint.endpoint || !endpoint.apiKey || !endpoint.model) {
          throw new Error("Missing endpoint, apiKey, or model for azure-gpt");
        }
        const gptToken = CredentialVault.resolve(endpoint.apiKey, passphrase);
        if (!gptToken) {
          throw new Error("Failed to decipher or resolve API Key for Azure GPT (Responses API)");
        }
        return new AzureGPTProvider({
          endpoint: endpoint.endpoint,
          apiKey: gptToken,
          model: endpoint.model,
        });
      }

      case "anthropic": {
        if (!endpoint.model) {
          throw new Error("Missing model for anthropic provider");
        }
        // apiKey 解決: 設定値があればそれを優先、 無ければ env:ANTHROPIC_API_KEY にフォールバック
        const raw = endpoint.apiKey ?? "env:ANTHROPIC_API_KEY";
        const token = CredentialVault.resolve(raw, passphrase);
        if (!token) {
          throw new Error("ANTHROPIC_API_KEY が見つかりません。/model setup anthropic で設定するか、 環境変数 ANTHROPIC_API_KEY をセットしてください。");
        }
        return new AnthropicProvider({
          apiKey: token,
          model: endpoint.model,
        });
      }

      case "claude-cli": {
        if (!endpoint.model) {
          throw new Error("Missing model for claude-cli provider");
        }
        return new ClaudeCliProvider({
          model: endpoint.model,
          // 既定で claude 内部のツール実行を許可 (= claude が自律的にファイル操作などを行う)。
          // 「純粋なテキスト生成器」 として使いたい場合は config.json の claudeCli.allowTools=false で抑制 (未実装)。
        });
      }

      default:
        throw new Error(`Unknown cloud provider type: ${endpoint.providerType}`);
    }
  }

  // ローカルLLM
  if (!endpoint.baseUrl) {
    throw new Error("Missing baseUrl for local LLM provider");
  }
  return createProviderByType(endpoint.providerType as ProviderType, endpoint.baseUrl);
}

/**
 * メインLLM (および visionLLM) 用の Provider ファクトリ。
 * ローカル/クラウド両対応。クラウドの場合 passphrase で apiKey を復号する。
 */
export function createProvider(endpoint: LLMEndpoint, passphrase?: string): LLMProvider {
  return createProviderFromEndpoint(endpoint, passphrase);
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

/**
 * セカンドLLM用の Provider ファクトリ。
 * メインと同じ実装に委譲 (ローカル/クラウド両対応 + apiKey 復号)。
 */
export function createSecondLLMProvider(endpoint: SecondLLMEndpoint, passphrase?: string): LLMProvider {
  return createProviderFromEndpoint(endpoint, passphrase);
}
