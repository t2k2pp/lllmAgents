import type { LLMProvider } from "../../providers/base-provider.js";
import type { ToolHandler } from "../tool-registry.js";
export declare class VisionService {
    private provider;
    private model;
    constructor(provider: LLMProvider, model: string);
    analyzeImage(imageBase64: string, prompt: string): Promise<string>;
}
export declare function createVisionTool(visionService: VisionService): ToolHandler;
//# sourceMappingURL=vision.d.ts.map