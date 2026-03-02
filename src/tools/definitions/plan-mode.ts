import type { ToolHandler } from "../tool-registry.js";
import type { PlanManager } from "../../agent/plan-mode.js";

let planManager: PlanManager | null = null;

export function setPlanManager(manager: PlanManager): void {
  planManager = manager;
}

export function getPlanManager(): PlanManager | null {
  return planManager;
}

export const enterPlanModeTool: ToolHandler = {
  name: "enter_plan_mode",
  definition: {
    type: "function",
    function: {
      name: "enter_plan_mode",
      description: `プランモードに入る。プランモードでは、コードベースを調査して実装計画を設計する。
読み取り専用ツール(file_read, glob, grep, web_fetch, web_search)のみ使用可能。
計画が完了したらexit_plan_modeで承認を依頼する。

以下の場合に使用:
- 新機能の実装
- 複数の有効なアプローチがある場合
- アーキテクチャ決定が必要な場合
- 複数ファイルにまたがる変更
- 要件が不明確な場合`,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  async execute() {
    if (!planManager) {
      return { success: false, output: "", error: "PlanManager not initialized" };
    }

    if (planManager.isInPlanMode()) {
      return { success: false, output: "", error: "Already in plan mode" };
    }

    const plan = planManager.enterPlanMode();

    return {
      success: true,
      output: JSON.stringify({
        mode: "planning",
        planId: plan.id,
        planFile: plan.filePath,
        message: "プランモードに入りました。コードベースを調査して実装計画を設計してください。計画が完了したらexit_plan_modeを使用してください。",
        allowedTools: Array.from(PlanManagerClass.getPlanModeAllowedTools()),
      }),
    };
  },
};

// Need to import PlanManager class for static method access
import { PlanManager as PlanManagerClass } from "../../agent/plan-mode.js";

export const exitPlanModeTool: ToolHandler = {
  name: "exit_plan_mode",
  definition: {
    type: "function",
    function: {
      name: "exit_plan_mode",
      description: `プランモードを終了し、ユーザーに計画の承認を依頼する。
プランの内容をplan_contentパラメータに記述する。
ユーザーが承認すると実装を開始できる。`,
      parameters: {
        type: "object",
        properties: {
          plan_content: {
            type: "string",
            description: "実装計画の内容(Markdown形式)",
          },
        },
        required: ["plan_content"],
      },
    },
  },

  async execute(params: Record<string, unknown>) {
    if (!planManager) {
      return { success: false, output: "", error: "PlanManager not initialized" };
    }

    if (!planManager.isInPlanMode()) {
      return { success: false, output: "", error: "Not in plan mode" };
    }

    const content = params.plan_content as string;
    planManager.updatePlanContent(content);

    const result = await planManager.requestApproval();

    if (result.approved) {
      planManager.exitPlanMode();
      return {
        success: true,
        output: JSON.stringify({
          approved: true,
          message: "計画が承認されました。実装を開始してください。",
        }),
      };
    }

    if (result.feedback) {
      return {
        success: true,
        output: JSON.stringify({
          approved: false,
          feedback: result.feedback,
          message: "フィードバックに基づいて計画を修正してください。",
        }),
      };
    }

    planManager.exitPlanMode();
    return {
      success: true,
      output: JSON.stringify({
        approved: false,
        message: "計画が却下されました。",
      }),
    };
  },
};
