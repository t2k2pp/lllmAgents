export class DelegationGuard {
    config;
    consecutiveCount = 0;
    totalCount = 0;
    constructor(config) {
        this.config = config;
    }
    checkDelegation() {
        if (this.totalCount >= this.config.maxTotalDelegations) {
            return { allowed: false, reason: `Reached maximum total delegations per session (${this.config.maxTotalDelegations}).` };
        }
        if (this.consecutiveCount >= this.config.maxConsecutiveDelegations) {
            return { allowed: false, reason: `Reached maximum consecutive delegations (${this.config.maxConsecutiveDelegations}).` };
        }
        return { allowed: true };
    }
    recordDelegation() {
        this.consecutiveCount++;
        this.totalCount++;
    }
    onUserTurn() {
        this.consecutiveCount = 0;
    }
    getStats() {
        return {
            consecutiveCount: this.consecutiveCount,
            totalCount: this.totalCount,
            maxConsecutive: this.config.maxConsecutiveDelegations,
            maxTotal: this.config.maxTotalDelegations,
        };
    }
}
//# sourceMappingURL=delegation-guard.js.map