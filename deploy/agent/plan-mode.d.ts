export type PlanState = "idle" | "planning" | "awaiting_approval" | "approved" | "rejected";
export interface Plan {
    id: string;
    state: PlanState;
    content: string;
    filePath: string;
    createdAt: string;
    feedback?: string;
}
export declare class PlanManager {
    private currentPlan;
    private plansDir;
    constructor();
    getState(): PlanState;
    isInPlanMode(): boolean;
    enterPlanMode(): Plan;
    updatePlanContent(content: string): void;
    requestApproval(): Promise<{
        approved: boolean;
        feedback?: string;
    }>;
    exitPlanMode(): void;
    getCurrentPlan(): Plan | null;
    /** planモードで許可するツール（調査+設計。実装系はブロックしないが注意喚起で制御） */
    static getPlanModeAllowedTools(): Set<string>;
    /** planモード中に使うと「実装開始」とみなすツール */
    static getImplementationTools(): Set<string>;
}
//# sourceMappingURL=plan-mode.d.ts.map