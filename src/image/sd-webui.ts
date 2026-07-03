import type { ImageProvider, ImageGenRequest, ImageGenResult } from "./image-provider.js";
import { parseSize } from "./image-provider.js";
import { getOpsLogger } from "../utils/ops-logger.js";

/**
 * Stable Diffusion WebUI (AUTOMATIC1111) txt2img プロバイダ。
 * 設計: docs/image-generation.md §4.3
 *
 * POST {baseUrl}/sdapi/v1/txt2img
 *   { prompt, negative_prompt, width, height, steps, batch_size, seed }
 * 応答: { images: ["<base64>", ...] }
 *
 * ローカル想定 (認証なし)。コストは常に 0。
 */

interface SdWebuiConfig {
  /** 例: http://localhost:7860 */
  baseUrl: string;
  defaultSize?: string;
  negativePrompt?: string;
  steps?: number;
}

interface Txt2ImgResponse {
  images?: string[];
  detail?: string;
}

export class SdWebuiProvider implements ImageProvider {
  readonly providerType = "sd-webui" as const;

  constructor(private config: SdWebuiConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.trim().replace(/\/$/, "");
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const size = req.size ?? this.config.defaultSize ?? "1024x1024";
    const dim = parseSize(size);
    if (!dim) {
      throw new Error(`Invalid size "${size}" — expected "WxH" (e.g. "1024x1024")`);
    }

    const body = {
      prompt: req.prompt,
      negative_prompt: req.negativePrompt ?? this.config.negativePrompt ?? "",
      width: dim.width,
      height: dim.height,
      steps: this.config.steps ?? 25,
      batch_size: req.n ?? 1,
      seed: req.seed ?? -1,
    };

    getOpsLogger().info("image", "sd-webui txt2img", {
      baseUrl: this.baseUrl,
      size,
      steps: body.steps,
      n: body.batch_size,
    });

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/sdapi/v1/txt2img`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(
        `SD WebUI に接続できません (${this.baseUrl}): ${e instanceof Error ? e.message : String(e)}\n` +
          `WebUI を --api オプション付きで起動しているか確認してください。`,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`SD WebUI txt2img failed (HTTP ${res.status}): ${text.slice(0, 2000)}`);
    }

    let parsed: Txt2ImgResponse;
    try {
      parsed = JSON.parse(text) as Txt2ImgResponse;
    } catch {
      throw new Error(`SD WebUI txt2img: unexpected non-JSON response: ${text.slice(0, 500)}`);
    }
    const images = (parsed.images ?? []).map((b64) => {
      // 一部設定では "data:image/png;base64," プレフィックスが付く
      const idx = b64.indexOf(",");
      const raw = b64.startsWith("data:") && idx >= 0 ? b64.slice(idx + 1) : b64;
      return Buffer.from(raw, "base64");
    });
    if (images.length === 0) {
      throw new Error(`SD WebUI txt2img returned no images: ${text.slice(0, 500)}`);
    }

    return { images, model: "sd-webui", costUsd: 0 };
  }
}
