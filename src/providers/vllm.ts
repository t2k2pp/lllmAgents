import { OpenAICompatProvider } from "./openai-compat.js";

export class VLLMProvider extends OpenAICompatProvider {
  constructor(baseUrl: string) {
    super("vllm", baseUrl);
  }

  // vLLM is fully OpenAI-compatible, no special overrides needed
  // Vision support detection would need model-specific knowledge

  async supportsVision(modelName: string): Promise<boolean> {
    const lower = modelName.toLowerCase();
    return (
      lower.includes("llava") ||
      lower.includes("qwen-vl") ||
      lower.includes("qwen2-vl") ||
      lower.includes("phi-3.5-vision") ||
      lower.includes("pixtral") ||
      lower.includes("internvl")
    );
  }
}
