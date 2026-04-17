export class BudgetGuard {
    budgetConfig;
    constructor(budgetConfig) {
        this.budgetConfig = { ...budgetConfig };
    }
    /** 予算チェック */
    checkBudget(currentTotalCostUsd) {
        const { limitUsd, warningThreshold, stopThreshold } = this.budgetConfig;
        if (currentTotalCostUsd >= limitUsd * stopThreshold) {
            return {
                status: "exceeded",
                message: `予算上限の${Math.round(stopThreshold * 100)}%に到達しました ($${currentTotalCostUsd.toFixed(4)} / $${limitUsd.toFixed(2)})。セカンドLLMの利用を停止します。`,
            };
        }
        if (currentTotalCostUsd >= limitUsd * warningThreshold) {
            const usedPercent = (currentTotalCostUsd / limitUsd) * 100;
            const remainingUsd = limitUsd - currentTotalCostUsd;
            return {
                status: "warning",
                usedPercent,
                remainingUsd,
                message: `予算の${Math.round(usedPercent)}%を使用しました ($${currentTotalCostUsd.toFixed(4)} / $${limitUsd.toFixed(2)})。残り: $${remainingUsd.toFixed(4)}`,
            };
        }
        return { status: "ok" };
    }
    /** 予算上限を動的に変更 */
    updateLimit(newLimitUsd) {
        this.budgetConfig.limitUsd = newLimitUsd;
    }
    /** 現在の予算設定を取得 */
    getConfig() {
        return { ...this.budgetConfig };
    }
}
//# sourceMappingURL=budget-guard.js.map