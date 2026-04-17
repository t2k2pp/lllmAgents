import type { ModelInfo } from "../config/types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
export declare class LMStudioProvider extends OpenAICompatProvider {
    constructor(baseUrl: string);
    listModels(): Promise<ModelInfo[]>;
    supportsVision(modelName: string): Promise<boolean>;
}
//# sourceMappingURL=lmstudio.d.ts.map