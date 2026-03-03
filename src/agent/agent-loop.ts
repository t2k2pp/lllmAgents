import chalk from "chalk";
import ora from "ora";
import type { LLMProvider, ToolCall, ToolDefinition } from "../providers/base-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { PermissionManager } from "../security/permission-manager.js";
import type { HookManager } from "../hooks/hook-manager.js";
import { MessageHistory } from "./message-history.js";
import { ContextManager } from "./context-manager.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  createSession,
  saveSession,
  type SessionData,
} from "./session-manager.js";
import { PlanManager } from "./plan-mode.js";
import type { ContextModeManager } from "../context/context-mode.js";
import * as logger from "../utils/logger.js";

const MAX_TOOL_ITERATIONS = 50;
const MAX_RETRIES = 2;

export class AgentLoop {
  private history: MessageHistory;
  private contextManager: ContextManager;
  private toolExecutor: ToolExecutor;
  private session: SessionData;
  private planManager: PlanManager | null = null;
  private contextModeManager: ContextModeManager | null = null;

  constructor(
    private provider: LLMProvider,
    private model: string,
    private toolRegistry: ToolRegistry,
    private permissions: PermissionManager,
    contextWindow: number,
    compressionThreshold: number,
    contextModeManager?: ContextModeManager,
    hookManager?: HookManager,
  ) {
    this.contextModeManager = contextModeManager ?? null;
    const systemPrompt = buildSystemPrompt(contextModeManager);
    this.history = new MessageHistory(systemPrompt);
    this.contextManager = new ContextManager(provider, model, contextWindow, compressionThreshold);
    this.toolExecutor = new ToolExecutor(toolRegistry, permissions, hookManager);
    this.session = createSession(model);
  }

  setPlanManager(pm: PlanManager): void {
    this.planManager = pm;
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
          const toolDefs = this.getFilteredToolDefs();
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

      // Tool calls: execute (parallel when multiple) and continue
      if (toolCalls.length > 0) {
        this.history.addAssistantMessage(textContent, toolCalls);

        if (toolCalls.length === 1) {
          await this.executeSingleTool(toolCalls[0]);
        } else {
          await this.executeToolsParallel(toolCalls);
        }
        continue;
      }

      // Final response
      this.history.addAssistantMessage(textContent);
      return;
    }

    console.log(chalk.yellow("\n  Maximum tool iterations reached."));
  }

  /** Get tool definitions, filtered by plan mode if active */
  private getFilteredToolDefs(): ToolDefinition[] {
    const allDefs = this.toolRegistry.getDefinitions();

    if (this.planManager?.isInPlanMode()) {
      const allowed = PlanManager.getPlanModeAllowedTools();
      return allDefs.filter((d) => allowed.has(d.function.name));
    }

    return allDefs;
  }

  /** Execute a single tool call */
  private async executeSingleTool(toolCall: ToolCall): Promise<void> {
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

  /** Execute multiple tool calls in parallel with Promise.allSettled */
  private async executeToolsParallel(toolCalls: ToolCall[]): Promise<void> {
    console.log(chalk.dim(`\n  ⟹ ${toolCalls.length} tools in parallel...`));

    const promises = toolCalls.map(async (toolCall) => {
      const result = await this.toolExecutor.execute(toolCall);
      const icon = result.success ? chalk.green("✓") : chalk.red("✗");
      const suffix = result.success ? "" : `: ${result.error}`;
      console.log(chalk.dim(`  ${icon} ${toolCall.function.name}${suffix}`));
      return { toolCall, result };
    });

    const settled = await Promise.allSettled(promises);

    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        const { toolCall, result } = entry.value;
        const resultContent = result.success
          ? result.output
          : `Error: ${result.error}\n${result.output}`;
        this.history.addToolResult(toolCall.id, resultContent);
      } else {
        logger.error("Parallel tool execution error:", entry.reason);
      }
    }
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
    const systemPrompt = buildSystemPrompt(this.contextModeManager ?? undefined);
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

  getProvider(): LLMProvider {
    return this.provider;
  }

  getModel(): string {
    return this.model;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getPermissions(): PermissionManager {
    return this.permissions;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
