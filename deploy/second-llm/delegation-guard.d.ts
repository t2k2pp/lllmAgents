export interface DelegationGuardConfig {
    maxConsecutiveDelegations: number;
    maxTotalDelegations: number;
}
export declare class DelegationGuard {
    private config;
    private consecutiveCount;
    private totalCount;
    constructor(config: DelegationGuardConfig);
    checkDelegation(): {
        allowed: boolean;
        reason?: string;
    };
    recordDelegation(): void;
    onUserTurn(): void;
    getStats(): {
        consecutiveCount: number;
        totalCount: number;
        maxConsecutive: number;
        maxTotal: number;
    };
}
//# sourceMappingURL=delegation-guard.d.ts.map