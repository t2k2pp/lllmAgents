import type { ToolHandler } from "../tool-registry.js";
import type { PlanManager } from "../../agent/plan-mode.js";
export declare function setPlanManager(manager: PlanManager): void;
export declare function getPlanManager(): PlanManager | null;
export declare const enterPlanModeTool: ToolHandler;
export declare const exitPlanModeTool: ToolHandler;
//# sourceMappingURL=plan-mode.d.ts.map