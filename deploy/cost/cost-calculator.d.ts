import type { ModelPricing } from "./pricing-table.js";
export interface ReferenceCost {
    model: string;
    estimatedCostUsd: number;
}
export declare class CostCalculator {
    /**
     * 通常のコスト計算
     */
    calculate(inputTokens: number, outputTokens: number, pricing: ModelPricing): number;
    calculateForModel(model: string, inputTokens: number, outputTokens: number): number;
    /**
     * キャッシュ考慮のコスト計算
     */
    calculateWithCache(inputTokens: number, outputTokens: number, cachedTokens: number, pricing: ModelPricing): number;
    /**
     * ローカルLLM利用時のクラウド参考コスト算出
     */
    calculateReferencesCosts(inputTokens: number, outputTokens: number, referenceModels: string[]): ReferenceCost[];
}
export declare const globalCostCalculator: CostCalculator;
//# sourceMappingURL=cost-calculator.d.ts.map