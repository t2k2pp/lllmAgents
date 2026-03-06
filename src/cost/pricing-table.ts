import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface ModelPricing {
  inputPerMToken: number;     // USD per 1M input tokens
  outputPerMToken: number;    // USD per 1M output tokens
  cachedInputPerMToken?: number; // キャッシュヒット時の入力単価
}

// 組み込み料金テーブル (2026年3月時点)
export const BUILTIN_PRICING: Record<string, ModelPricing> = {
  // --- Gemini (Vertex AI) ---
  "gemini-3-pro":          { inputPerMToken: 2.00,  outputPerMToken: 12.00 },
  "gemini-3-flash":        { inputPerMToken: 0.50,  outputPerMToken: 3.00 },
  "gemini-2.5-pro":        { inputPerMToken: 1.25,  outputPerMToken: 10.00 },
  "gemini-2.5-flash":      { inputPerMToken: 0.30,  outputPerMToken: 2.50 },
  "gemini-2.5-flash-lite": { inputPerMToken: 0.10,  outputPerMToken: 0.40 },

  // --- GPT (Azure OpenAI) ---
  "gpt-5.4":     { inputPerMToken: 2.50,  outputPerMToken: 15.00 },
  "gpt-5.2":     { inputPerMToken: 1.75,  outputPerMToken: 14.00 },
  "gpt-5.1":     { inputPerMToken: 1.25,  outputPerMToken: 10.00 },
  "gpt-5-mini":  { inputPerMToken: 0.25,  outputPerMToken: 2.00 },
  "gpt-5-nano":  { inputPerMToken: 0.05,  outputPerMToken: 0.40 },
  "gpt-4o":      { inputPerMToken: 5.00,  outputPerMToken: 15.00 },
  "gpt-4o-mini": { inputPerMToken: 0.15,  outputPerMToken: 0.60 },

  // --- Claude (Azure AI Foundry / Vertex AI Model Garden) ---
  "claude-opus-4.6":    { inputPerMToken: 5.00,  outputPerMToken: 25.00 },
  "claude-sonnet-4.6":  { inputPerMToken: 3.00,  outputPerMToken: 15.00 },
  "claude-haiku-4.5":   { inputPerMToken: 1.00,  outputPerMToken: 5.00 },
};

const PRICING_FILE = path.join(os.homedir(), ".localllm", "pricing.json");

/**
 * 料金テーブルをロード。
 * ユーザーカスタム単価 (~/.localllm/pricing.json) があれば組み込みを上書き。
 */
export function loadPricing(): Record<string, ModelPricing> {
  const pricing = { ...BUILTIN_PRICING };

  try {
    if (fs.existsSync(PRICING_FILE)) {
      const raw = fs.readFileSync(PRICING_FILE, "utf-8");
      const custom = JSON.parse(raw) as Record<string, ModelPricing>;
      for (const [model, price] of Object.entries(custom)) {
        pricing[model] = { ...pricing[model], ...price };
      }
    }
  } catch {
    // カスタム料金ファイル読み込みエラーは無視
  }

  return pricing;
}

/**
 * モデル名から料金を取得。
 * 部分一致も試行する（例: "gemini-3-flash-001" → "gemini-3-flash"）。
 */
export function getModelPricing(model: string): ModelPricing | null {
  const pricing = loadPricing();

  // 完全一致
  if (pricing[model]) {
    return pricing[model];
  }

  // 部分一致（モデル名がプレフィックスとして含まれる場合）
  for (const [key, value] of Object.entries(pricing)) {
    if (model.startsWith(key)) {
      return value;
    }
  }

  return null;
}
