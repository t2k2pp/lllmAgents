import type { LLMProvider } from "../../providers/base-provider.js";
import { collectResponse } from "../../providers/base-provider.js";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export class VisionService {
  constructor(
    private provider: LLMProvider,
    private model: string,
  ) {}

  async analyzeImage(imageBase64: string, prompt: string): Promise<string> {
    const gen = this.provider.chatWithVision({
      model: this.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
          ],
        },
      ],
      temperature: 0.3,
      stream: true,
    });

    const response = await collectResponse(gen);
    return response.content;
  }
}

export function createVisionTool(visionService: VisionService): ToolHandler {
  return {
    name: "vision_analyze",
    definition: {
      type: "function",
      function: {
        name: "vision_analyze",
        description: "画像を分析して内容を説明します。Base64エンコードされた画像データとプロンプトを渡してください。",
        parameters: {
          type: "object",
          properties: {
            image_base64: {
              type: "string",
              description: "Base64エンコードされた画像データ",
            },
            prompt: {
              type: "string",
              description: "画像について質問するプロンプト",
            },
          },
          required: ["image_base64", "prompt"],
        },
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await visionService.analyzeImage(
          params.image_base64 as string,
          params.prompt as string,
        );
        return { success: true, output: result };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
