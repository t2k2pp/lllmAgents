import chalk from "chalk";
import ora from "ora";
import type { LLMProvider, ToolCall } from "../providers/base-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { PermissionManager } from "../security/permission-manager.js";
import { MessageHistory } from "./message-history.js";
import { ContextManager } from "./context-manager.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  createSession,
  saveSession,
  type SessionData,
} from "./session-manager.js";
import * as logger from "../utils/logger.js";

const MAX_TOOL_ITERATIONS = 50;
const MAX_RETRIES = 2;

export class AgentLoop {
  private history: MessageHistory;
  private contextManager: ContextManager;
  private toolExecutor: ToolExecutor;
  private session: SessionData;

  constructor(
    private provider: LLMProvider,
    private model: string,
    private toolRegistry: ToolRegistry,
    permissions: PermissionManager,
    contextWindow: number,
    compressionThreshold: number,
  ) {
    const systemPrompt = buildSystemPrompt();
    this.history = new MessageHistory(systemPrompt);
    this.contextManager = new ContextManager(provider, model, contextWindow, compressionThreshold);
    this.toolExecutor = new ToolExecutor(toolRegistry, permissions);
    this.session = createSession(model);
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

      // Call LLM with retry
      let textContent = "";
      const toolCalls: ToolCall[] = [];
      let hasStartedOutput = false;
      let success = false;

      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
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
                throw new Error(chunk.error ?? "LLM error");
              case "done":
                break;
            }
          }

          success = true;
          break;
        } catch (e) {
          if (retry < MAX_RETRIES) {
            const waitMs = 1000 * (retry + 1);
            console.log(chalk.yellow(`\n  リトライ中 (${retry + 1}/${MAX_RETRIES})...`));
            await sleep(waitMs);
            textContent = "";
            toolCalls.length = 0;
            hasStartedOutput = false;
          } else {
            console.error(chalk.red(`\n  Error: ${e instanceof Error ? e.message : String(e)}`));
            return;
          }
        }
      }

      if (!success) return;

      if (hasStartedOutput) {
        process.stdout.write("\n");
      }

      // Tool calls: execute and continue
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
        continue;
      }

      // Final response
      this.history.addAssistantMessage(textContent);
      return;
    }

    console.log(chalk.yellow("\n  Maximum tool iterations reached."));
  }

  async forceCompress(): Promise<void> {
    await this.contextManager.compress(this.history);
  }

  saveCurrentSession(): void {
    this.session.messages = this.history.getRawMessages();
    saveSession(this.session);
    logger.debug(`Session saved: ${this.session.meta.id}`);
  }

  restoreSession(sessionData: SessionData): void {
    this.session = sessionData;
    const systemPrompt = buildSystemPrompt();
    this.history = new MessageHistory(systemPrompt);
    for (const msg of sessionData.messages) {
      if (msg.role === "user") {
        this.history.addUserMessage(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      } else if (msg.role === "assistant") {
        this.history.addAssistantMessage(
          typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          msg.tool_calls,
        );
      } else if (msg.role === "tool") {
        this.history.addToolResult(msg.tool_call_id ?? "", typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      }
    }
  }

  getHistory(): MessageHistory {
    return this.history;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
