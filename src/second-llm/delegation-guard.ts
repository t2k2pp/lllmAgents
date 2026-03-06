export interface DelegationGuardConfig {
  maxConsecutiveDelegations: number;
  maxTotalDelegations: number;
}

export class DelegationGuard {
  private config: DelegationGuardConfig;
  private consecutiveCount = 0;
  private totalCount = 0;

  constructor(config: DelegationGuardConfig) {
    this.config = config;
  }

  checkDelegation(): { allowed: boolean; reason?: string } {
    if (this.totalCount >= this.config.maxTotalDelegations) {
      return { allowed: false, reason: `Reached maximum total delegations per session (${this.config.maxTotalDelegations}).` };
    }
    if (this.consecutiveCount >= this.config.maxConsecutiveDelegations) {
      return { allowed: false, reason: `Reached maximum consecutive delegations (${this.config.maxConsecutiveDelegations}).` };
    }
    return { allowed: true };
  }

  recordDelegation(): void {
    this.consecutiveCount++;
    this.totalCount++;
  }

  onUserTurn(): void {
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
