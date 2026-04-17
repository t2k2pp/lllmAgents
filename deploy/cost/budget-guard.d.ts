import type { BudgetConfig } from "../config/types.js";
export type BudgetStatus = {
    status: "ok";
} | {
    status: "warning";
    usedPercent: number;
    remainingUsd: number;
    message: string;
} | {
    status: "exceeded";
    message: string;
};
export declare class BudgetGuard {
    private budgetConfig;
    constructor(budgetConfig: BudgetConfig);
    /** 予算チェック */
    checkBudget(currentTotalCostUsd: number): BudgetStatus;
    /** 予算上限を動的に変更 */
    updateLimit(newLimitUsd: number): void;
    /** 現在の予算設定を取得 */
    getConfig(): BudgetConfig;
}
//# sourceMappingURL=budget-guard.d.ts.map