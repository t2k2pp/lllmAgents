import type { SkillRegistry } from "../../skills/skill-registry.js";
import type {
  WorkflowLearnScope,
  WorkflowLearnStatus,
  WorkflowLearner,
} from "../../workflow-learning/workflow-learner.js";
import type { ToolExecutionContext, ToolHandler, ToolResult } from "../tool-registry.js";

function localOnly(context?: ToolExecutionContext): ToolResult | null {
  if (context?.source && context.source !== "cli") {
    return {
      success: false,
      output: "",
      error:
        "Workflow learning is available only from the local CLI. Remote sessions cannot record or save host operations.",
      errorKind: "permanent",
    };
  }
  return null;
}

function formatStatus(status: WorkflowLearnStatus): string {
  const capabilities = status.supportedScopes.length > 0 ? status.supportedScopes.join(", ") : "none";
  if (!status.active) return `Workflow recording is inactive. Available scopes: ${capabilities}.`;
  return (
    `Workflow recording '${status.name}' is active (scope=${status.scope}). ` +
    `successful steps=${status.successfulSteps}, failed steps=${status.failedSteps}. ` +
    "Only sanitized parameters are retained; tool outputs are not recorded."
  );
}

function fail(error: unknown): ToolResult {
  return {
    success: false,
    output: "",
    error: error instanceof Error ? error.message : String(error),
    errorKind: "permanent",
  };
}

export function createWorkflowLearningTools(learner: WorkflowLearner, registry: SkillRegistry): ToolHandler[] {
  const start: ToolHandler = {
    name: "workflow_learn_start",
    workspacePolicy: "forbidden",
    definition: {
      type: "function",
      function: {
        name: "workflow_learn_start",
        description:
          "ユーザーが明示的に教えたいbrowser/computer操作の記録を開始します。" +
          "このcallは単独で実行し、成功を待ってから対象操作を順番に行ってください。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "生成するproject skill名 (kebab-case)" },
            description: { type: "string", description: "何を達成するworkflowか。秘密値を含めない" },
            scope: { type: "string", enum: ["browser", "computer", "both"] },
          },
          required: ["name", "description", "scope"],
        },
      },
    },
    async execute(params, context) {
      const blocked = localOnly(context);
      if (blocked) return blocked;
      try {
        return {
          success: true,
          output: formatStatus(
            learner.start(params.name as string, params.description as string, params.scope as WorkflowLearnScope),
          ),
        };
      } catch (error) {
        return fail(error);
      }
    },
  };

  const status: ToolHandler = {
    name: "workflow_learn_status",
    workspacePolicy: "forbidden",
    definition: {
      type: "function",
      function: {
        name: "workflow_learn_status",
        description: "現在の操作記録状態と、利用可能なbrowser/computer scopeを表示します。",
        parameters: { type: "object", properties: {} },
      },
    },
    async execute(_params, context) {
      const blocked = localOnly(context);
      if (blocked) return blocked;
      return { success: true, output: formatStatus(learner.status()) };
    },
  };

  const finish: ToolHandler = {
    name: "workflow_learn_finish",
    workspacePolicy: "forbidden",
    definition: {
      type: "function",
      function: {
        name: "workflow_learn_finish",
        description:
          "失敗のない記録をproject-localの手動起動skillへ保存し、現在sessionへ登録します。" +
          "入力文字列などはplaceholder化され、既存skillは上書きしません。",
        parameters: { type: "object", properties: {} },
      },
    },
    async execute(_params, context) {
      const blocked = localOnly(context);
      if (blocked) return blocked;
      try {
        const result = learner.finish(registry);
        return {
          success: true,
          output:
            `Learned ${result.stepCount} successful step(s) as manual-only skill '${result.skill.trigger}'.\n` +
            `Saved: ${result.filePath}\n` +
            `Redacted placeholders: ${result.placeholderCount}. Invoke the skill directly with ${result.skill.trigger}.`,
        };
      } catch (error) {
        return fail(error);
      }
    },
  };

  const cancel: ToolHandler = {
    name: "workflow_learn_cancel",
    workspacePolicy: "forbidden",
    definition: {
      type: "function",
      function: {
        name: "workflow_learn_cancel",
        description: "現在の操作記録を保存せず破棄します。既存skillや操作対象は変更しません。",
        parameters: { type: "object", properties: {} },
      },
    },
    async execute(_params, context) {
      const blocked = localOnly(context);
      if (blocked) return blocked;
      try {
        learner.cancel();
        return { success: true, output: "Workflow recording was cancelled. No skill was written." };
      } catch (error) {
        return fail(error);
      }
    },
  };

  return [start, status, finish, cancel];
}
