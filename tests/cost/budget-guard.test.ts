import { describe, it, expect } from "vitest";
import { BudgetGuard } from "../../src/cost/budget-guard.js";
import type { BudgetConfig } from "../../src/config/types.js";

describe("BudgetGuard", () => {
  const defaultConfig: BudgetConfig = {
    limitUsd: 10.00,
    warningThreshold: 0.8,
    stopThreshold: 0.95,
  };

  describe("checkBudget", () => {
    it("予算内であれば ok を返す", () => {
      const guard = new BudgetGuard(defaultConfig);
      const result = guard.checkBudget(5.0);
      expect(result.status).toBe("ok");
    });

    it("warningThreshold を超えたら warning を返す", () => {
      const guard = new BudgetGuard(defaultConfig);
      const result = guard.checkBudget(8.5); // 85% > 80%
      expect(result.status).toBe("warning");
      if (result.status === "warning") {
        expect(result.usedPercent).toBeCloseTo(85);
        expect(result.remainingUsd).toBeCloseTo(1.5);
      }
    });

    it("stopThreshold を超えたら exceeded を返す", () => {
      const guard = new BudgetGuard(defaultConfig);
      const result = guard.checkBudget(9.6); // 96% > 95%
      expect(result.status).toBe("exceeded");
    });

    it("ちょうど stopThreshold の場合は exceeded", () => {
      const guard = new BudgetGuard(defaultConfig);
      const result = guard.checkBudget(9.5); // 95% == 95%
      expect(result.status).toBe("exceeded");
    });

    it("ちょうど warningThreshold の場合は warning", () => {
      const guard = new BudgetGuard(defaultConfig);
      const result = guard.checkBudget(8.0); // 80% == 80%
      expect(result.status).toBe("warning");
    });

    it("0コストの場合は ok", () => {
      const guard = new BudgetGuard(defaultConfig);
      const result = guard.checkBudget(0);
      expect(result.status).toBe("ok");
    });
  });

  describe("updateLimit", () => {
    it("予算上限を変更できる", () => {
      const guard = new BudgetGuard(defaultConfig);
      guard.updateLimit(20.0);

      // 元の8.5は20ドルの42.5% → ok
      const result = guard.checkBudget(8.5);
      expect(result.status).toBe("ok");
    });
  });

  describe("getConfig", () => {
    it("設定のコピーが返される", () => {
      const guard = new BudgetGuard(defaultConfig);
      const config = guard.getConfig();
      expect(config.limitUsd).toBe(10.00);
      expect(config.warningThreshold).toBe(0.8);
      expect(config.stopThreshold).toBe(0.95);
    });
  });
});
