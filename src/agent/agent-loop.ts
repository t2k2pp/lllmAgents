import chalk from "chalk";
import ora from "ora";
import type { LLMProvider, ToolCall } from "../providers/base-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { PermissionManager } from "../security/permission-manager.js";
import { MessageHistory } from "./message-history.js";
import { ContextManager } from "./context-manager.js";
import * as logger from "../utils/logger.js";

const MAX_TOOL_ITERATIONS = 50;

const SYSTEM_PROMPT = `あなたはLocalLLM Agent - CLIベースのAIアシスタントです。
ユーザーのPC上でファイル操作、コマンド実行、ブラウザ操作を行えます。

利用可能なツールを活用して、ユーザーのタスクを遂行してください。
セキュリティに配慮し、破壊的な操作は慎重に行ってください。
回答は簡潔かつ正確に。
`;

export class AgentLoop {
  private history: MessageHistory;
  private contextManager: ContextManager;
  private toolExecutor: ToolExecutor;

  constructor(
    private provider: LLMProvider,
    private model: string,
    private toolRegistry: ToolRegistry,
    _permissions: PermissionManager,
    contextWindow: number,
    compressionThreshold: number,
  ) {
    this.history = new MessageHistory(SYSTEM_PROMPT);
    this.contextManager = new ContextManager(provider, model, contextWindow, compressionThreshold);
    this.toolExecutor = new ToolExecutor(toolRegistry, _permissions);
  }

  async run(userMessage: string): Promise<void> {
    this.history.addUserMessage(userMessage);

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      // Context compression check
      if (this.contextManager.shouldCompress(this.history)) {
        const compressSpinner = ora("コンテキストを圧縮中...").start();
        try {
          await this.contextManager.compress(this.history);
          compressSpinner.succeed("コンテキストを圧縮しました");
        } catch (e) {
          compressSpinner.fail("圧縮に失敗しました");
          logger.error("Context compression failed:", e);
        }
      }

      // Call LLM with tools
      const toolDefs = this.toolRegistry.getDefinitions();
      const gen = toolDefs.length > 0
        ? this.provider.chatWithTools({
            model: this.model,
            messages: this.history.getMessages(),
            tools: toolDefs,
            stream: true,
          })
        : this.provider.chat({
            model: this.model,
            messages: this.history.getMessages(),
            stream: true,
          });

      // Process streaming response
      let textContent = "";
      const toolCalls: ToolCall[] = [];
      let hasStartedOutput = false;

      for await (const chunk of gen) {
        switch (chunk.type) {
          case "text":
            if (chunk.text) {
              if (!hasStartedOutput) {
                hasStartedOutput = true;
                process.stdout.write("\n");
              }
              process.stdout.write(chunk.text);
              textContent += chunk.text;
            }
            break;
          case "tool_call":
            if (chunk.toolCall) {
              toolCalls.push(chunk.toolCall);
            }
            break;
          case "error":
            console.error(chalk.red(`\n  Error: ${chunk.error}`));
            return;
          case "done":
            break;
        }
      }

      if (hasStartedOutput) {
        process.stdout.write("\n");
      }

      // If tool calls: execute them and continue loop
      if (toolCalls.length > 0) {
        this.history.addAssistantMessage(textContent, toolCalls);

        for (const toolCall of toolCalls) {
          const spinner = ora(chalk.dim(`  ${toolCall.function.name}...`)).start();
          const result = await this.toolExecutor.execute(toolCall);

          if (result.success) {
            spinner.succeed(chalk.dim(`  ${toolCall.function.name}`));
          } else {
            spinner.fail(chalk.dim(`  ${toolCall.function.name}: ${result.error}`));
          }

          const resultContent = result.success
            ? result.output
            : `Error: ${result.error}\n${result.output}`;
          this.history.addToolResult(toolCall.id, resultContent);
        }
        // Continue loop: LLM will see tool results
        continue;
      }

      // No tool calls: final response
      this.history.addAssistantMessage(textContent);
      return;
    }

    console.log(chalk.yellow("\n  Maximum tool iterations reached."));
  }

  getHistory(): MessageHistory {
    return this.history;
  }
}
