import { describe, it, expect } from "vitest";
import { DelegationGuard } from "../../src/second-llm/delegation-guard.js";

describe("DelegationGuard", () => {
  const config = {
    maxConsecutiveDelegations: 3,
    maxTotalDelegations: 5,
  };

  it("初期状態では allowed: true", () => {
    const guard = new DelegationGuard(config);
    expect(guard.checkDelegation().allowed).toBe(true);
  });

  it("連続回数上限に達するとブロックされる", () => {
    const guard = new DelegationGuard(config);
    guard.recordDelegation();
    guard.recordDelegation();
    guard.recordDelegation(); // consecutiveCount = 3
    const result = guard.checkDelegation();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("consecutive");
  });

  it("ユーザー操作で連続回数がリセットされる", () => {
    const guard = new DelegationGuard(config);
    guard.recordDelegation();
    guard.recordDelegation(); // consecutiveCount = 2
    guard.onUserTurn(); // リセット
    guard.recordDelegation();
    guard.recordDelegation(); // consecutiveCount = 2
    expect(guard.checkDelegation().allowed).toBe(true);
  });

  it("合計回数上限に達するとブロックされる", () => {
    const guard = new DelegationGuard(config);
    for (let i = 0; i < 5; i++) {
      guard.recordDelegation();
      guard.onUserTurn(); // 連続回数をリセットしながら合計を増やす
    }
    // totalCount = 5
    const result = guard.checkDelegation();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("total");
  });

  it("getStatsで統計情報を取得できる", () => {
    const guard = new DelegationGuard(config);
    guard.recordDelegation();
    guard.recordDelegation();
    const stats = guard.getStats();
    expect(stats.consecutiveCount).toBe(2);
    expect(stats.totalCount).toBe(2);
    expect(stats.maxConsecutive).toBe(3);
    expect(stats.maxTotal).toBe(5);
  });
});
