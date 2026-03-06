import ora from "ora";
import chalk from "chalk";
import { DelegationGuard } from "./delegation-guard.js";
import { createSecondLLMProvider } from "../providers/provider-factory.js";
import type { SecondLLMConfig, SecondLLMEndpoint } from "../config/types.js";
import type { LLMProvider, ChatResponse, ChatChunk, Message, ToolDefinition, ToolCall } from "../providers/base-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { PermissionManager } from "../security/permission-manager.js";

const EXCLUDED_TOOLS = [
  "task",
  "task_output",
  "second_llm_consult", // avoid recursive calls
  "second_llm_agent",
  "enter_plan_mode",
  "exit_plan_mode"
];

export class SecondLLMManager {
  private provider: LLMProvider | null = null;
  private config: SecondLLMConfig | null = null;
  private endpoint: SecondLLMEndpoint | null = null;
  private delegationGuard: DelegationGuard | null = null;

  constructor(
    private toolRegistry: ToolRegistry,
    private permissions: PermissionManager,
  ) {}

  initialize(config: SecondLLMConfig, passphrase?: string) {
    this.config = config;
    if (config.enabled && config.endpoint) {
      this.endpoint = config.endpoint;
      this.provider = createSecondLLMProvider(this.endpoint, passphrase);
    }
    
    // Setup DelegationGuard
    this.delegationGuard = new DelegationGuard({
      maxConsecutiveDelegations: 5,
      maxTotalDelegations: 20,
    });
  }

  isAvailable(): boolean {
    return this.provider !== null && this.config !== null && this.config.enabled;
  }

  onUserTurn(): void {
    if (this.delegationGuard) {
      this.delegationGuard.onUserTurn();
    }
  }

  getConfig(): SecondLLMConfig | null {
    return this.config;
  }

  getEndpoint(): SecondLLMEndpoint | null {
    return this.endpoint;
  }

  getProvider(): LLMProvider | null {
    return this.provider;
  }

  protected checkDelegation(): void {
    if (!this.delegationGuard) return;
    const check = this.delegationGuard.checkDelegation();
    if (!check.allowed) {
      throw new Error(`Second LLM Delegation blocked: ${check.reason}`);
    }
    this.delegationGuard.recordDelegation();
  }

  async consult(prompt: string): Promise<string> {
    if (!this.isAvailable() || !this.provider || !this.endpoint) {
      throw new Error("Second LLM is not configured or enabled.");
    }
    this.checkDelegation();

    const spinner = ora(chalk.magenta("Consulting Second LLM...")).start();
    try {
      const messages: Message[] = [
        { role: "system", content: "You are an expert AI assistant consulted by another AI agent. Provide a direct, factual, and complete answer. Do not ask questions back." },
        { role: "user", content: prompt }
      ];

      const stream = this.provider.chat({
        model: this.endpoint.model,
        messages,
        temperature: 0.2,
        stream: true
      });

      let responseText = "";
      for await (const chunk of stream) {
        if (chunk.type === "text") {
          responseText += chunk.text;
        } else if (chunk.type === "error") {
          throw new Error(chunk.error);
        }
      }
      
      spinner.succeed(chalk.magenta("Second LLM replied."));
      return responseText.trim();
    } catch (e) {
      spinner.fail(chalk.red("Second LLM consultation failed."));
      throw e;
    }
  }

  async runAsAgent(prompt: string): Promise<string> {
    if (!this.isAvailable() || !this.provider || !this.endpoint) {
      throw new Error("Second LLM is not configured or enabled.");
    }
    this.checkDelegation();

    const allowedTools = this.toolRegistry.getTools().filter(t => !EXCLUDED_TOOLS.includes(t.name));
    const toolDefs: ToolDefinition[] = allowedTools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>
      }
    }));

    const spinner = ora(chalk.magenta("Second LLM working as Agent...")).start();
    try {
      const messages: Message[] = [
        { role: "system", content: "You are an expert AI sub-agent. Complete the task using available tools. Do not ask questions back to the user. Provide the final result of your task." },
        { role: "user", content: prompt }
      ];

      const toolExecutor = new ToolExecutor(this.toolRegistry, this.permissions);
      let iteration = 0;
      const MAX_ITERATIONS = 15;
      
      while (iteration < MAX_ITERATIONS) {
        iteration++;
        const stream = this.provider.chatWithTools({
          model: this.endpoint.model,
          messages,
          tools: toolDefs,
          stream: true
        });

        let responseText = "";
        const toolCalls: ToolCall[] = [];

        for await (const chunk of stream) {
          if (chunk.type === "text") {
            responseText += chunk.text;
          } else if (chunk.type === "tool_call") {
            if (chunk.toolCall) toolCalls.push(chunk.toolCall);
          } else if (chunk.type === "error") {
            throw new Error(chunk.error);
          }
        }

        if (responseText) {
          messages.push({ role: "assistant", content: responseText });
          if (toolCalls.length === 0) {
            spinner.succeed(chalk.magenta("Second LLM task completed."));
            return responseText.trim();
          }
        }

        if (toolCalls.length > 0) {
          if (!responseText) {
             messages.push({ role: "assistant", content: "", tool_calls: toolCalls });
          } else {
             messages[messages.length - 1].tool_calls = toolCalls;
          }

          for (const tc of toolCalls) {
            const toolName = tc.function.name;
            const args = tc.function.arguments;
            spinner.text = chalk.magenta(`Second LLM executing tool: ${toolName}`);
            
            try {
              const res = await toolExecutor.executeTool(toolName, args);
              messages.push({ role: "tool", content: res, tool_call_id: tc.id });
            } catch (e) {
              messages.push({ role: "tool", content: `Error: ${String(e)}`, tool_call_id: tc.id });
            }
          }
          spinner.text = chalk.magenta("Second LLM working as Agent...");
        } else {
          break;
        }
      }

      spinner.succeed(chalk.magenta("Second LLM task reached max iterations or completed."));
      return "Reached maximum iterations or completed.";
    } catch (e) {
      spinner.fail(chalk.red("Second LLM agent run failed."));
      throw e;
    }
  }
}
