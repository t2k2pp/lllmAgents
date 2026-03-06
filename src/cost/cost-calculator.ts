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
   * キャッシュ考慮のコスト計算
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
