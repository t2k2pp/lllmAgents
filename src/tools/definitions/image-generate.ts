import type { ToolHandler, ToolResult } from "../tool-registry.js";
import type { ImageService } from "../../image/image-service.js";
import type { Config } from "../../config/types.js";
import { sendDiscordFiles } from "../../utils/discord.js";
import * as logger from "../../utils/logger.js";

/**
 * image_generate ツール: テキストプロンプトから画像を生成してファイル保存する。
 * 設計: docs/image-generation.md §5
 *
 * 登録ゲート: config.imageGen.enabled かつ active profile があるときのみ登録
 * (browser ゲートと同型。無効時はツールが見えない＝エージェントが無駄試行しない)。
 *
 * config は Discord 自動添付の判定に使う (ライブ参照: /discord 切替が即反映される)。
 */
export function createImageGenerateTool(imageService: ImageService, config: Config): ToolHandler {
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

        // Discord 自動添付 (ベストエフォート: 失敗してもツールは成功扱い)。
        // 設定はライブ参照し、有効時のみ生成画像を webhook に添付する。
        await maybeSendToDiscord(config, prompt, result);

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

/** プロンプトを添付メッセージ用に短く切り詰める */
function truncatePrompt(prompt: string, max = 300): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * 生成画像を Discord webhook に添付する (ベストエフォート)。
 * 有効条件: discord.enabled && webhookUrl があり、attachGeneratedImages が false でない。
 * 失敗は警告ログのみ (画像生成自体は成功しているため、ツール結果には影響させない)。
 */
async function maybeSendToDiscord(
  config: Config,
  prompt: string,
  result: { savedPaths: string[]; providerType: string; model: string },
): Promise<void> {
  const dc = config.discord;
  if (!dc?.enabled || !dc.webhookUrl) return;
  if (dc.attachGeneratedImages === false) return;
  if (result.savedPaths.length === 0) return;

  try {
    const caption = `🖼 画像を生成しました (${result.providerType}/${result.model})\nprompt: ${truncatePrompt(prompt)}`;
    await sendDiscordFiles(dc.webhookUrl, caption, result.savedPaths, dc.maxAttachmentMb);
  } catch (e) {
    logger.warn(`Discord への画像添付でエラー (無視して続行): ${e}`);
  }
}
