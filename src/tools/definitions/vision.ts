import * as fs from "node:fs";
import * as path from "node:path";
import type { LLMProvider } from "../../providers/base-provider.js";
import { collectResponse } from "../../providers/base-provider.js";
import type { ToolExecutionContext, ToolHandler, ToolResult } from "../tool-registry.js";
import { sideCall } from "../../agent/side-call.js";

export class VisionService {
  constructor(
    private provider: LLMProvider,
    private model: string,
  ) {}

  /**
   * REPL から /models (Add new / Set as vision) で vision LLM を差し替えた際に呼ぶ。
   * (docs/model-registry.md Phase 5)
   */
  setProvider(provider: LLMProvider, model: string): void {
    this.provider = provider;
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  async analyzeImage(imageBase64: string, prompt: string, mimeType = "image/png"): Promise<string> {
    const gen = sideCall("vision", this.provider, {
      method: "chatWithVision",
      params: {
        model: this.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            ],
          },
        ],
        temperature: 0.3,
        stream: true,
      },
    });

    const response = await collectResponse(gen);
    return response.content;
  }
}

/**
 * 視覚モデルへの問い。 いまのタスクの依頼の原文があれば前置きにする (視覚モデルは会話の文脈を持たないため、
 * 何を作っているのかを知らせる。 docs/in-context-vision-design.md §9)
 */
export function buildVisionPrompt(prompt: string, taskRequest: string | undefined): string {
  if (!taskRequest || taskRequest.trim().length === 0) return prompt;
  return `## 作業中のタスクの依頼 (参考。 画像はこの依頼のための途中の成果物)
${taskRequest.trim()}

## 質問
${prompt}`;
}

export function createVisionTool(visionService: VisionService): ToolHandler {
  return {
    name: "vision_analyze",
    definition: {
      type: "function",
      function: {
        name: "vision_analyze",
        description:
          "画像ファイルを別の視覚モデル (会話の文脈を持たない) に見せ、 質問への答えを文字で受け取る。 " +
          "メインのモデルが画像を見られる設定なら、 まず file_read で画像を開いて自分の目で確かめること (会話の文脈と照らせる)。 " +
          "これは文脈なしの第二の意見が欲しいとき、 またはメインのモデルが画像を見られないときに使う。 " +
          "質問は「何の動物か」 のような種類当てではなく、 位置・比率など確かめたい具体的な点を書く (例: 目は頭の高さの何割の所にあるか)。",
        parameters: {
          type: "object",
          properties: {
            image_path: {
              type: "string",
              description: "分析する画像ファイルの絶対パス",
            },
            prompt: {
              type: "string",
              description: "画像について質問するプロンプト",
            },
          },
          required: ["image_path", "prompt"],
        },
      },
    },
    async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
      try {
        const imagePath = params.image_path as string;
        if (!fs.existsSync(imagePath)) {
          return { success: false, output: "", error: `ファイルが見つかりません: ${imagePath}` };
        }

        const base64 = fs.readFileSync(imagePath, "base64");

        const mimeTypes: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
        };
        const mimeType = mimeTypes[path.extname(imagePath).toLowerCase()];
        if (!mimeType) return { success: false, output: "", error: "Use a PNG, JPEG or WebP image" };
        const result = await visionService.analyzeImage(
          base64,
          buildVisionPrompt(params.prompt as string, context?.taskRequest),
          mimeType,
        );
        return { success: true, output: result };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
