import type { ModelPricing } from "./pricing-table.js";
import { getModelPricing } from "./pricing-table.js";

export interface ReferenceCost {
  model: string;
  estimatedCostUsd: number;
}

export class CostCalculator {
  /**
   * 通常のコスト計算
   */
  calculate(
    inputTokens: number,
    outputTokens: number,
    pricing: ModelPricing,
  ): number {
    return (inputTokens * pricing.inputPerMToken / 1_000_000)
         + (outputTokens * pricing.outputPerMToken / 1_000_000);
  }

  calculateForModel(
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    const pricing = getModelPricing(model);
    if (!pricing) return 0;
    return this.calculate(inputTokens, outputTokens, pricing);
  }

  /**
   * キャッシュ考慮でモデル名から計算。
   * cachedTokens は inputTokens の内数 (キャッシュヒットした入力分)。
   * pricing に cachedInputPerMToken が無ければ通常入力単価にフォールバック (= 割引なし)。
   */
  calculateForModelWithCache(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
  ): number {
    const pricing = getModelPricing(model);
    if (!pricing) return 0;
    return this.calculateWithCache(inputTokens, outputTokens, cachedTokens, pricing);
  }

  /**
   * キャッシュ考慮のコスト計算 (OpenAI セマンティクス)。
   * inputTokens は cachedTokens を **内包** する前提 (OpenAI/Azure GPT の prompt_tokens)。
   */
  calculateWithCache(
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
    pricing: ModelPricing,
  ): number {
    const uncachedInput = inputTokens - cachedTokens;
    const cachedRate = pricing.cachedInputPerMToken ?? pricing.inputPerMToken;
    return (uncachedInput * pricing.inputPerMToken / 1_000_000)
         + (cachedTokens * cachedRate / 1_000_000)
         + (outputTokens * pricing.outputPerMToken / 1_000_000);
  }

  /**
   * Anthropic セマンティクスの内訳コスト計算 (docs/prompt-cache-cost-reduction.md)。
   * Anthropic は input_tokens(=uncachedInputTokens) が cache 読込/書込を **含まない** ため、
   * 3 種を別々に課金する:
   *   - uncachedInputTokens: 通常入力単価 (1×)
   *   - cacheReadTokens:     cachedInputPerMToken (0.1×。 未設定なら割引なし)
   *   - cacheCreationTokens: 入力単価 × 1.25 (5分TTL の書込プレミアム)
   */
  calculateWithCacheBreakdown(
    uncachedInputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
    pricing: ModelPricing,
  ): number {
    const cachedRate = pricing.cachedInputPerMToken ?? pricing.inputPerMToken;
    const cacheWriteRate = pricing.inputPerMToken * 1.25;
    return (uncachedInputTokens * pricing.inputPerMToken / 1_000_000)
         + (cacheReadTokens * cachedRate / 1_000_000)
         + (cacheCreationTokens * cacheWriteRate / 1_000_000)
         + (outputTokens * pricing.outputPerMToken / 1_000_000);
  }

  /** モデル名から Anthropic セマンティクスの内訳コストを計算 */
  calculateForModelWithCacheBreakdown(
    model: string,
    uncachedInputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
  ): number {
    const pricing = getModelPricing(model);
    if (!pricing) return 0;
    return this.calculateWithCacheBreakdown(
      uncachedInputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, pricing,
    );
  }

  /**
   * ローカルLLM利用時のクラウド参考コスト算出
   */
  calculateReferencesCosts(
    inputTokens: number,
    outputTokens: number,
    referenceModels: string[],
  ): ReferenceCost[] {
    return referenceModels
      .map((model) => {
        const pricing = getModelPricing(model);
        if (!pricing) return null;
        return {
          model,
          estimatedCostUsd: this.calculate(inputTokens, outputTokens, pricing),
        };
      })
      .filter((r): r is ReferenceCost => r !== null);
  }
}

export const globalCostCalculator = new CostCalculator();
