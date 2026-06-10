import type { ImageProviderType } from "../config/types.js";

/**
 * 画像生成プロバイダの共通インターフェース。
 * 設計: docs/image-generation.md §4
 *
 * チャット用 LLMProvider (src/providers/) とは形が違いすぎるため別系統とする。
 */

export interface ImageGenRequest {
  /** 生成プロンプト (英語推奨) */
  prompt: string;
  /** "WxH" (例 "1024x1024")。未指定はプロバイダ/プロファイル既定 */
  size?: string;
  /** azure-image のみ意味を持つ */
  quality?: "low" | "medium" | "high";
  /** 生成枚数 (既定 1) */
  n?: number;
  /** sd-webui / comfyui のみ */
  negativePrompt?: string;
  /** sd-webui / comfyui のみ。未指定はランダム */
  seed?: number;
}

export interface ImageGenResult {
  /** PNG バイナリ */
  images: Buffer[];
  /** コスト記録用モデル名 (例: "gpt-image-2" / "sd-webui" / "comfyui") */
  model: string;
  /** 推定コスト (USD)。ローカル系は常に 0 */
  costUsd: number;
  warnings?: string[];
}

export interface ImageProvider {
  readonly providerType: ImageProviderType;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

/** "WxH" 文字列をパース。不正なら null */
export function parseSize(size: string): { width: number; height: number } | null {
  const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(size.trim());
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}
