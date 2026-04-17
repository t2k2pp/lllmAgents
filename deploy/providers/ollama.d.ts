import type { ModelInfo, ModelDetail } from "../config/types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
export declare class OllamaProvider extends OpenAICompatProvider {
    constructor(baseUrl: string);
    testConnection(): Promise<boolean>;
    listModels(): Promise<ModelInfo[]>;
    getModelInfo(modelName: string): Promise<ModelDetail>;
    private getModelDetail;
    supportsVision(modelName: string): Promise<boolean>;
}
//# sourceMappingURL=ollama.d.ts.map