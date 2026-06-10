import type { ToolHandler, ToolResult } from "../tool-registry.js";
import type { ImageService } from "../../image/image-service.js";

/**
 * image_generate ツール: テキストプロンプトから画像を生成してファイル保存する。
 * 設計: docs/image-generation.md §5
 *
 * 登録ゲート: config.imageGen.enabled かつ active profile があるときのみ登録
 * (browser ゲートと同型。無効時はツールが見えない＝エージェントが無駄試行しない)。
 */
export function createImageGenerateTool(imageService: ImageService): ToolHandler {
  return {
    name: "image_generate",
    definition: {
      type: "function",
      function: {
        name: "image_generate",
        description:
          "Generate images from a text prompt using the configured image generation backend " +
          "(Azure GPT Images / Stable Diffusion WebUI / ComfyUI). " +
          "Write prompts in English for best results. Saves PNG file(s) to output_path. " +
          "Use this for game assets, slide illustrations, website images, etc.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Image description prompt (English recommended). Be specific about style, subject, composition.",
            },
            output_path: {
              type: "string",
              description: "Absolute path of the PNG file to save (e.g. C:\\proj\\assets\\hero.png). When n>1, files are numbered -2, -3, ...",
            },
            size: {
              type: "string",
              description: 'Image size "WxH" (e.g. "1024x1024", "1536x1024"). Default: profile setting (1024x1024).',
            },
            quality: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Quality (Azure GPT Images only). Higher = more expensive. Default: profile setting (medium).",
            },
            n: {
              type: "number",
              description: "Number of images to generate (1-4). Default: 1.",
            },
            negative_prompt: {
              type: "string",
              description: "Things to avoid in the image (Stable Diffusion / ComfyUI only).",
            },
          },
          required: ["prompt", "output_path"],
        },
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const prompt = params.prompt as string;
        const outputPath = params.output_path as string;
        if (!prompt || !outputPath) {
          return { success: false, output: "", error: "prompt と output_path は必須です" };
        }
        // 暴走コスト防止: 1 回の呼び出しで最大 4 枚
        let n = typeof params.n === "number" ? Math.floor(params.n) : 1;
        if (n < 1) n = 1;
        if (n > 4) n = 4;

        const result = await imageService.generateAndSave(
          {
            prompt,
            size: typeof params.size === "string" ? params.size : undefined,
            quality:
              params.quality === "low" || params.quality === "medium" || params.quality === "high"
                ? params.quality
                : undefined,
            n,
            negativePrompt:
              typeof params.negative_prompt === "string" ? params.negative_prompt : undefined,
          },
          outputPath,
        );

        const lines = [
          `画像を生成しました (${result.providerType} / ${result.model}):`,
          ...result.savedPaths.map((p) => `  ${p}`),
          result.costUsd > 0 ? `推定コスト: $${result.costUsd.toFixed(4)}` : "コスト: $0 (ローカル生成)",
          ...result.warnings.map((w) => `⚠ ${w}`),
        ];
        return { success: true, output: lines.join("\n") };
      } catch (e) {
        return { success: false, output: "", error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
