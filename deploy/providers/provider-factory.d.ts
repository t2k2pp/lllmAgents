import type { LLMEndpoint, ProviderType, SecondLLMEndpoint } from "../config/types.js";
import type { LLMProvider } from "./base-provider.js";
export declare function createProvider(endpoint: LLMEndpoint): LLMProvider;
export declare function createProviderByType(type: ProviderType, baseUrl: string): LLMProvider;
export declare function createSecondLLMProvider(endpoint: SecondLLMEndpoint, passphrase?: string): LLMProvider;
//# sourceMappingURL=provider-factory.d.ts.map