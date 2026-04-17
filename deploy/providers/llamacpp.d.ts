import type { ModelInfo, ModelDetail } from "../config/types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
export declare class LlamaCppProvider extends OpenAICompatProvider {
    constructor(baseUrl: string);
    testConnection(): Promise<boolean>;
    listModels(): Promise<ModelInfo[]>;
    getModelInfo(modelName: string): Promise<ModelDetail>;
}
//# sourceMappingURL=llamacpp.d.ts.map