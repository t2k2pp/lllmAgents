import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * 画像生成の単価テーブル (USD / 枚)。設計: docs/image-generation.md §6.2
 *
 * トークン単価 (pricing-table.ts) とは軸が違う (枚数×品質×サイズ) ため別ファイル。
 * 1024x1024 を基準単価とし、他サイズはピクセル数比でスケールする近似。
 * 正確な請求はトークンベースだが、/cost の目的 (概算把握) には十分。
 */

export type ImageQuality = "low" | "medium" | "high";

// 組み込み画像単価 (2026-05 Azure GA 時点、1024x1024 基準)
export const BUILTIN_IMAGE_PRICING: Record<string, Record<ImageQuality, number>> = {
  "gpt-image-2": { low: 0.006, medium: 0.053, high: 0.211 },
  "gpt-image-1": { low: 0.011, medium: 0.042, high: 0.167 },
  "gpt-image-1-mini": { low: 0.005, medium: 0.011, high: 0.036 },
};

const IMAGE_PRICING_FILE = path.join(os.homedir(), ".localllm", "image-pricing.json");

/** 組み込み + ユーザーカスタム (~/.localllm/image-pricing.json) をマージしてロード */
export function loadImagePricing(): Record<string, Record<ImageQuality, number>> {
  const pricing = { ...BUILTIN_IMAGE_PRICING };
  try {
    if (fs.existsSync(IMAGE_PRICING_FILE)) {
      const raw = fs.readFileSync(IMAGE_PRICING_FILE, "utf-8");
      const custom = JSON.parse(raw) as Record<string, Record<ImageQuality, number>>;
      for (const [model, price] of Object.entries(custom)) {
        pricing[model] = { ...pricing[model], ...price };
      }
    }
  } catch {
    // カスタム料金ファイル読み込みエラーは無視
  }
  return pricing;
}

const BASE_PIXELS = 1024 * 1024;

/**
 * 画像 1 枚の推定単価 (USD)。モデル未登録なら null (呼び出し側で警告表示)。
 * 部分一致 (prefix) も試行する (例: "gpt-image-2-2026-04-21" → "gpt-image-2")。
 */
export function getImageUnitPrice(model: string, quality: ImageQuality, width: number, height: number): number | null {
  const pricing = loadImagePricing();
  let entry = pricing[model];
  if (!entry) {
    for (const [key, value] of Object.entries(pricing)) {
      if (model.startsWith(key)) {
        entry = value;
        break;
      }
    }
  }
  if (!entry || typeof entry[quality] !== "number") return null;
  const scale = (width * height) / BASE_PIXELS;
  return entry[quality] * scale;
}
