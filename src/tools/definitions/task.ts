import chalk from "chalk";
import type { ToolHandler, ToolExecutionContext } from "../tool-registry.js";
import type { SubAgentManager, SubAgentType } from "../../agent/sub-agent.js";
import { ROOT_ANCESTORS } from "../../agent/delegation-context.js";

let subAgentManager: SubAgentManager | null = null;

export function setSubAgentManager(manager: SubAgentManager): void {
  subAgentManager = manager;
}

export function getSubAgentManager(): SubAgentManager | null {
  return subAgentManager;
}

export const taskTool: ToolHandler = {
  name: "task",
  definition: {
    type: "function",
    function: {
      name: "task",
      description:
        "メインLLM (あなた自身) を別コンテキストで起動してサブタスクを委任する。\n" +
        "[使うべき場面] (1) メインLLM の特性 (例: 大コンテキスト・特定の専門性) が活きるタスク。 " +
        "(2) 探索系 (explore / plan agent type) で読取専用の調査をメインから分離。 " +
        "(3) second_llm_agent と並列起動して総時間短縮 (parallelCapable=true 時)。\n" +
        "[使うべきでない] (1) セカンドLLM の特性が活きるタスク → second_llm_agent を優先。 " +
        "(2) 自分で 30 秒以内にできる軽作業 → インライン処理。 " +
        "(3) 細切れの連続委任 → 修正をまとめて 1 回で渡す。\n" +
        "[よくある誤用] (a) explore / plan agent に編集タスクを渡す → 読取専用なので失敗する。 " +
        "(b) general-purpose に「ファイル一覧出して」 程度を委任 → glob で十分。 " +
        "(c) bash agent に複雑な多段タスクを丸投げ → general-purpose を選ぶ。 " +
        "(d) code-reviewer agent に新規コードを書かせる → コードレビュー専任。\n" +
        "[利用可能タイプ] explore (コード調査・読取専用) / plan (実装計画・読取専用) / " +
        "general-purpose (全ツール) / bash (コマンド実行特化) / code-reviewer (品質・セキュリティレビュー特化)。\n" +
        "[second_llm_agent との使い分け] task = メインLLM (= あなた自身) / " +
        "second_llm_agent = 別モデル。 モデル特性で選ぶ。\n" +
        "[並列起動] 独立したタスクは複数同時起動で総時間短縮可能 (run_in_background + task_output)。",
      parameters: {
        type: "object",
        properties: {
          subagent_type: {
            type: "string",
            enum: ["explore", "plan", "general-purpose", "bash", "code-reviewer"],
            description: "サブエージェントのタイプ",
          },
          description: {
            type: "string",
            description: "タスクの短い説明 (3-5語)",
          },
          prompt: {
            type: "string",
            description: "サブエージェントへの詳細な指示",
          },
          run_in_background: {
            type: "boolean",
            description: "バックグラウンドで実行する場合true。結果は後でtask_outputツールで取得。",
          },
        },
        required: ["subagent_type", "description", "prompt"],
      },
    },
  },

  async execute(params: Record<string, unknown>, context?: ToolExecutionContext) {
    if (!subAgentManager) {
      return { success: false, output: "", error: "SubAgentManager not initialized" };
    }

    const type = params.subagent_type as SubAgentType;
    const description = params.description as string;
    const prompt = params.prompt as string;
    const background = params.run_in_background as boolean | undefined;
    // D1: 呼出元の ancestors を SubAgentManager に伝播。 SubAgent 側で {sub} が追加される
    const parentAncestors = context?.ancestors ?? ROOT_ANCESTORS;

    console.log(chalk.dim(`\n  [Task] ${type}: ${description}`));

    if (background) {
      const agentId = subAgentManager.launchBackground(type, description, prompt, parentAncestors);
      return {
        success: true,
        output: JSON.stringify({
          agentId,
          status: "running",
          message: `サブエージェントをバックグラウンドで起動しました: ${agentId}`,
        }),
      };
    }

    const result = await subAgentManager.launchForeground(type, description, prompt, parentAncestors);

    return {
      success: result.success,
      output: JSON.stringify({
        agentId: result.agentId,
        type: result.type,
        description: result.description,
        result: result.result,
        success: result.success,
      }),
    };
  },
};

export const taskOutputTool: ToolHandler = {
  name: "task_output",
  definition: {
    type: "function",
    function: {
      name: "task_output",
      description: "バックグラウンドで実行中のサブエージェントの結果を取得する",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "サブエージェントのID",
          },
        },
        required: ["agent_id"],
      },
    },
  },

  async execute(params: Record<string, unknown>) {
    if (!subAgentManager) {
      return { success: false, output: "", error: "SubAgentManager not initialized" };
    }

    const agentId = params.agent_id as string;

    if (subAgentManager.isRunning(agentId)) {
      // Still running, wait for result
      console.log(chalk.dim(`  [TaskOutput] Waiting for ${agentId}...`));
    }

    const result = await subAgentManager.getResult(agentId);

    if (!result) {
      return {
        success: false,
        output: "",
        error: `Agent ${agentId} not found or already completed`,
      };
    }

    return {
      success: result.success,
      output: JSON.stringify(result),
    };
  },
};
