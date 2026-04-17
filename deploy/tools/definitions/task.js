import chalk from "chalk";
let subAgentManager = null;
export function setSubAgentManager(manager) {
    subAgentManager = manager;
}
export function getSubAgentManager() {
    return subAgentManager;
}
export const taskTool = {
    name: "task",
    definition: {
        type: "function",
        function: {
            name: "task",
            description: `サブエージェントを起動して複雑なタスクを委任する。
利用可能なタイプ:
- explore: コードベース探索(読取専用ツールのみ)
- plan: 実装計画の設計(読取専用ツールのみ)
- general-purpose: 汎用タスク(全ツール利用可能)
- bash: コマンド実行特化

複数のサブエージェントを並列に起動可能。独立したタスクは並列実行で効率化する。`,
            parameters: {
                type: "object",
                properties: {
                    subagent_type: {
                        type: "string",
                        enum: ["explore", "plan", "general-purpose", "bash"],
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
    async execute(params) {
        if (!subAgentManager) {
            return { success: false, output: "", error: "SubAgentManager not initialized" };
        }
        const type = params.subagent_type;
        const description = params.description;
        const prompt = params.prompt;
        const background = params.run_in_background;
        console.log(chalk.dim(`\n  [Task] ${type}: ${description}`));
        if (background) {
            const agentId = subAgentManager.launchBackground(type, description, prompt);
            return {
                success: true,
                output: JSON.stringify({
                    agentId,
                    status: "running",
                    message: `サブエージェントをバックグラウンドで起動しました: ${agentId}`,
                }),
            };
        }
        const result = await subAgentManager.launchForeground(type, description, prompt);
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
export const taskOutputTool = {
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
    async execute(params) {
        if (!subAgentManager) {
            return { success: false, output: "", error: "SubAgentManager not initialized" };
        }
        const agentId = params.agent_id;
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
//# sourceMappingURL=task.js.map