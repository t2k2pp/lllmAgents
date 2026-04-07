import type { ToolHandler, ToolResult } from "../tool-registry.js";
import type { SecondLLMManager } from "../../second-llm/second-llm-manager.js";

let secondLLMManager: SecondLLMManager | null = null;

export function setSecondLLMManager(manager: SecondLLMManager): void {
  secondLLMManager = manager;
}

export const secondLLMConsultTool: ToolHandler = {
  name: "second_llm_consult",
  definition: {
    type: "function",
    function: {
      name: "second_llm_consult",
      description: "セカンドLLMに質問・相談する。コードレビュー、方針の壁打ち、要約・分析など、ツール不要な単発の質問に使う。コンテキスト節約のため、大きな調査結果の要約にも有効。",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "セカンドLLMへの質問。背景・コンテキストを具体的に含めること。",
          },
        },
        required: ["prompt"],
      },
    }
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!secondLLMManager || !secondLLMManager.isAvailable()) {
      return { success: false, output: "", error: "Error: Second LLM is not configured or not enabled." };
    }
    const prompt = params.prompt as string;
    try {
      const result = await secondLLMManager.consult(prompt);
      return { success: true, output: result };
    } catch (e) {
      return { success: false, output: "", error: `Error from Second LLM: ${String(e)}` };
    }
  },
};

export const secondLLMAgentTool: ToolHandler = {
  name: "second_llm_agent",
  definition: {
    type: "function",
    function: {
      name: "second_llm_agent",
      description: "セカンドLLMにサブタスクを委任する。セカンドLLMがエージェントとしてツール（ファイル読み書き、bash等）を使い、独立してタスクを完遂し結果を返す。コンテキスト節約やファイル調査の委任に有効。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "セカンドLLMに実行させるタスクの詳細な説明。必要なコンテキスト・制約を全て含めること。",
          },
        },
        required: ["task"],
      },
    }
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!secondLLMManager || !secondLLMManager.isAvailable()) {
      return { success: false, output: "", error: "Error: Second LLM is not configured or not enabled." };
    }
    const task = params.task as string;
    try {
      const result = await secondLLMManager.runAsAgent(task);
      return { success: true, output: result };
    } catch (e) {
      return { success: false, output: "", error: `Error from Second LLM: ${String(e)}` };
    }
  },
};
