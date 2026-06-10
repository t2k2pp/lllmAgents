import type { ImageProvider, ImageGenRequest, ImageGenResult } from "./image-provider.js";
import { parseSize } from "./image-provider.js";
import { getImageUnitPrice, type ImageQuality } from "../cost/image-pricing.js";
import { getOpsLogger } from "../utils/ops-logger.js";

/**
 * Azure OpenAI 画像生成プロバイダ (gpt-image-1 系 / gpt-image-2)。
 * 設計: docs/image-generation.md §4.2
 *
 * curl 例:
 *   curl -X POST "https://YOUR-RESOURCE.openai.azure.com/openai/v1/images/generations?api-version=preview" \
 *     -H "Content-Type: application/json" -H "api-key: $KEY" \
 *     -d '{ "model": "gpt-image-2", "prompt": "...", "size": "1024x1024", "quality": "medium" }'
 *
 * - v1 系 API は body の model (= deployment 名) でルーティングする (deploymentName パス不要)
 * - 応答は常に b64_json (gpt-image 系は URL を返さない)
 * - DALL-E 3 は 2026-03 退役済みのため対象外
 */

interface AzureImageConfig {
  /** ホスト部のみ、または完全 URL (内部で base に正規化) */
  endpoint: string;
  /** 復号済み API Key (api-key ヘッダで送信) */
  apiKey: string;
  /** deployment 名 (例: gpt-image-2) */
  model: string;
  defaultSize?: string;
  defaultQuality?: ImageQuality;
}

interface ImagesGenerationsResponse {
  data?: Array<{ b64_json?: string; revised_prompt?: string }>;
  error?: { message?: string; code?: string };
}

export class AzureImageProvider implements ImageProvider {
  readonly providerType = "azure-image" as const;
  private baseUrl: string;

  constructor(private config: AzureImageConfig) {
    this.baseUrl = AzureImageProvider.normalizeEndpoint(config.endpoint);
  }

  /** 他 Azure プロバイダと同一仕様: 入力を protocol://host のみに正規化 */
  static normalizeEndpoint(input: string): string {
    const trimmed = input.trim().replace(/\/$/, "");
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host}`;
    } catch {
      return trimmed;
    }
  }

  private generationsUrl(): string {
    return `${this.baseUrl}/openai/v1/images/generations?api-version=preview`;
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const size = req.size ?? this.config.defaultSize ?? "1024x1024";
    const quality = req.quality ?? this.config.defaultQuality ?? "medium";
    const n = req.n ?? 1;

    const body = {
      model: this.config.model,
      prompt: req.prompt,
      size,
      quality,
      n,
      output_format: "png",
    };

    getOpsLogger().info("image", "azure-image generate", {
      model: this.config.model, size, quality, n,
    });

    const res = await fetch(this.generationsUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": this.config.apiKey },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      // サイズ/品質バリデーションはサーバーに任せ、エラー本文をそのまま返す (silent 欠損禁止)
      throw new Error(`Azure image generation failed (HTTP ${res.status}): ${text.slice(0, 2000)}`);
    }

    let parsed: ImagesGenerationsResponse;
    try {
      parsed = JSON.parse(text) as ImagesGenerationsResponse;
    } catch {
      throw new Error(`Azure image generation: unexpected non-JSON response: ${text.slice(0, 500)}`);
    }
    if (parsed.error) {
      throw new Error(`Azure image generation error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
    }
    const images = (parsed.data ?? [])
      .filter((d) => typeof d.b64_json === "string")
      .map((d) => Buffer.from(d.b64_json as string, "base64"));
    if (images.length === 0) {
      throw new Error(`Azure image generation returned no image data: ${text.slice(0, 500)}`);
    }

    // コスト: 枚数 × 単価 (品質×サイズスケール)。単価未登録は cost=0 + warning で顕在化
    const warnings: string[] = [];
    const dim = parseSize(size) ?? { width: 1024, height: 1024 };
    const unit = getImageUnitPrice(this.config.model, quality, dim.width, dim.height);
    let costUsd = 0;
    if (unit === null) {
      warnings.push(
        `画像単価が未登録のため cost=0 で計上: ${this.config.model} (~/.localllm/image-pricing.json に追記可)`,
      );
    } else {
      costUsd = unit * images.length;
    }

    return { images: images, model: this.config.model, costUsd, warnings: warnings.length ? warnings : undefined };
  }
}
