import { getModelPricing } from "./pricing-table.js";
export class CostCalculator {
    /**
     * 通常のコスト計算
     */
    calculate(inputTokens, outputTokens, pricing) {
        return (inputTokens * pricing.inputPerMToken / 1_000_000)
            + (outputTokens * pricing.outputPerMToken / 1_000_000);
    }
    calculateForModel(model, inputTokens, outputTokens) {
        const pricing = getModelPricing(model);
        if (!pricing)
            return 0;
        return this.calculate(inputTokens, outputTokens, pricing);
    }
    /**
     * キャッシュ考慮のコスト計算
     */
    calculateWithCache(inputTokens, outputTokens, cachedTokens, pricing) {
        const uncachedInput = inputTokens - cachedTokens;
        const cachedRate = pricing.cachedInputPerMToken ?? pricing.inputPerMToken;
        return (uncachedInput * pricing.inputPerMToken / 1_000_000)
            + (cachedTokens * cachedRate / 1_000_000)
            + (outputTokens * pricing.outputPerMToken / 1_000_000);
    }
    /**
     * ローカルLLM利用時のクラウド参考コスト算出
     */
    calculateReferencesCosts(inputTokens, outputTokens, referenceModels) {
        return referenceModels
            .map((model) => {
            const pricing = getModelPricing(model);
            if (!pricing)
                return null;
            return {
                model,
                estimatedCostUsd: this.calculate(inputTokens, outputTokens, pricing),
            };
        })
            .filter((r) => r !== null);
    }
}
export const globalCostCalculator = new CostCalculator();
//# sourceMappingURL=cost-calculator.js.map