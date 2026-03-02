import type { ModelInfo } from "../config/types.js";
import { OpenAICompatProvider } from "./openai-compat.js";

export class LMStudioProvider extends OpenAICompatProvider {
  constructor(baseUrl: string) {
    super("lmstudio", baseUrl);
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = await super.listModels();
    // LM Studio models: check name for vision indicators
    return models.map((m) => ({
      ...m,
      supportsVision: isLikelyVisionModel(m.name),
    }));
  }

  async supportsVision(modelName: string): Promise<boolean> {
    return isLikelyVisionModel(modelName);
  }
}

function isLikelyVisionModel(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("vision") ||
    lower.includes("llava") ||
    lower.includes("pixtral") ||
    lower.includes("qwen2.5-vl") ||
    lower.includes("qwen2-vl") ||
    lower.includes("gemma-3") ||
    lower.includes("minicpm-v")
  );
}
