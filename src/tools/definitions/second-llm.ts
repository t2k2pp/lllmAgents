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
      description: "Consult the second LLM for specific factual information or analysis. Suitable when you just need an answer without the LLM needing to use tools.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The prompt or question to ask the second LLM. Be as explicit and detailed as possible in giving the context.",
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
      description: "Delegate a complex sub-task to the second LLM. The second LLM will act as an agent, using available tools independently to solve the task and return the final result. Cannot create further sub-tasks.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "A comprehensive description of the task for the second LLM to perform. Include all necessary context and constraints.",
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
