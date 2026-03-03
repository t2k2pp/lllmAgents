import type { LLMProvider } from "../providers/base-provider.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { PermissionManager } from "../security/permission-manager.js";
import { MessageHistory } from "./message-history.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { collectResponse } from "../providers/base-provider.js";
import { AgentDefinitionLoader } from "../agents/agent-loader.js";
import type { AgentDefinition } from "../agents/agent-loader.js";
import * as logger from "../utils/logger.js";

const MAX_SUB_ITERATIONS = 30;

export type SubAgentType = "explore" | "plan" | "general-purpose" | "bash" | (string & {});

interface SubAgentConfig {
  type: SubAgentType;
  description: string;
  systemPrompt: string;
  maxTurns?: number;
  allowedTools?: string[];
}

// Hardcoded fallback configs for backward compatibility
const FALLBACK_CONFIGS: Record<string, Omit<SubAgentConfig, "description">> = {
  explore: {
    type: "explore",
    systemPrompt: `あなたはコードベース探索に特化したエージェントです。
ファイル検索(glob)、コンテンツ検索(grep)、ファイル読み取り(file_read)のツールを使って
コードベースを調査し、質問に答えてください。
ファイルの編集や書き込みは行わないでください。
調査結果を簡潔にまとめて報告してください。`,
    maxTurns: 20,
    allowedTools: ["file_read", "glob", "grep", "web_fetch", "web_search"],
  },
  plan: {
    type: "plan",
    systemPrompt: `あなたはソフトウェアアーキテクトエージェントです。
タスクの実装戦略を設計してください。
ファイル検索(glob)、コンテンツ検索(grep)、ファイル読み取り(file_read)のツールを使って
コードベースを調査し、ステップバイステップの実装計画を作成してください。
ファイルの編集や書き込みは行わないでください。
計画は具体的なファイルパスと変更内容を含めてください。`,
    maxTurns: 15,
    allowedTools: ["file_read", "glob", "grep", "web_fetch", "web_search"],
  },
  "general-purpose": {
    type: "general-purpose",
    systemPrompt: `あなたは汎用サブエージェントです。
指示されたタスクを自律的に実行してください。
利用可能なすべてのツールを使ってタスクを完了してください。
完了したら結果を簡潔に報告してください。`,
    maxTurns: 30,
  },
  bash: {
    type: "bash",
    systemPrompt: `あなたはコマンド実行に特化したエージェントです。
bashツールを使ってシェルコマンドを実行してください。
git操作、ビルド、テスト実行などのターミナルタスクを処理します。
結果を簡潔に報告してください。`,
    maxTurns: 15,
    allowedTools: ["bash", "file_read", "glob", "grep"],
  },
};

// Shared loader instance (lazy-initialized)
let sharedLoader: AgentDefinitionLoader | null = null;

function getLoader(): AgentDefinitionLoader {
  if (!sharedLoader) {
    sharedLoader = new AgentDefinitionLoader();
    sharedLoader.loadAll();
  }
  return sharedLoader;
}

/**
 * Resolve agent configuration by name.
 * Priority: external definition file > hardcoded fallback.
 */
function resolveAgentConfig(type: SubAgentType): Omit<SubAgentConfig, "description"> | null {
  const loader = getLoader();
  const externalDef = loader.get(type);

  if (externalDef) {
    logger.debug(`Using external agent definition for '${type}' from ${externalDef.source}`);
    return agentDefToConfig(externalDef);
  }

  const fallback = FALLBACK_CONFIGS[type];
  if (fallback) {
    logger.debug(`Using fallback config for agent type '${type}'`);
    return fallback;
  }

  return null;
}

/**
 * Convert an AgentDefinition (from .md file) to a SubAgentConfig.
 */
function agentDefToConfig(def: AgentDefinition): Omit<SubAgentConfig, "description"> {
  return {
    type: def.name,
    systemPrompt: def.systemPrompt,
    allowedTools: def.allowedTools.length > 0 ? def.allowedTools : undefined,
  };
}

export interface SubAgentResult {
  agentId: string;
  type: SubAgentType;
  description: string;
  result: string;
  success: boolean;
}

export class SubAgent {
  private agentId: string;
  private history: MessageHistory;
  private toolExecutor: ToolExecutor;
  private filteredRegistry: ToolRegistry;
  private config: SubAgentConfig;

  constructor(
    private provider: LLMProvider,
    private model: string,
    toolRegistry: ToolRegistry,
    permissions: PermissionManager,
    type: SubAgentType,
    description: string,
  ) {
    this.agentId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const resolved = resolveAgentConfig(type);
    if (!resolved) {
      throw new Error(`Unknown sub-agent type: '${type}'. No definition file or fallback found.`);
    }

    this.config = {
      ...resolved,
      description,
    };

    this.filteredRegistry = this.createFilteredRegistry(toolRegistry, this.config);
    this.history = new MessageHistory(this.config.systemPrompt);
    this.toolExecutor = new ToolExecutor(this.filteredRegistry, permissions);
  }

  private createFilteredRegistry(registry: ToolRegistry, config: SubAgentConfig): ToolRegistry {
    const filtered = new ToolRegistry();
    const allTools = registry.getToolNames();

    // If allowedTools is specified, use it as a whitelist
    if (config.allowedTools && config.allowedTools.length > 0) {
      const allowed = new Set(config.allowedTools);
      for (const name of allTools) {
        if (allowed.has(name)) {
          const handler = registry.get(name);
          if (handler) {
            filtered.register(handler);
          }
        }
      }
      return filtered;
    }

    // No allowedTools specified: register all tools except "task" (prevent recursion)
    for (const name of allTools) {
      if (name === "task") continue;
      const handler = registry.get(name);
      if (handler) {
        filtered.register(handler);
      }
    }

    return filtered;
  }

  async run(prompt: string): Promise<SubAgentResult> {
    this.history.addUserMessage(prompt);
    const maxTurns = this.config.maxTurns ?? MAX_SUB_ITERATIONS;
    let finalResult = "";

    for (let iteration = 0; iteration < maxTurns; iteration++) {
      try {
        const defs = this.filteredRegistry.getDefinitions();
        const gen = defs.length > 0
          ? this.provider.chatWithTools({
              model: this.model,
              messages: this.history.getMessages(),
              tools: defs,
              stream: true,
            })
          : this.provider.chat({
              model: this.model,
              messages: this.history.getMessages(),
              stream: true,
            });

        const response = await collectResponse(gen);

        if (response.toolCalls.length > 0) {
          this.history.addAssistantMessage(response.content, response.toolCalls);

          for (const toolCall of response.toolCalls) {
            const result = await this.toolExecutor.execute(toolCall);
            const resultContent = result.success
              ? result.output
              : `Error: ${result.error}\n${result.output}`;
            this.history.addToolResult(toolCall.id, resultContent);
          }
          continue;
        }

        // Final response - no tool calls
        this.history.addAssistantMessage(response.content);
        finalResult = response.content;
        break;
      } catch (e) {
        finalResult = `Error: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }

    if (!finalResult) {
      finalResult = "Maximum iterations reached without final response.";
    }

    return {
      agentId: this.agentId,
      type: this.config.type,
      description: this.config.description,
      result: finalResult,
      success: !finalResult.startsWith("Error:"),
    };
  }

  getAgentId(): string {
    return this.agentId;
  }
}

export class SubAgentManager {
  private runningAgents = new Map<string, Promise<SubAgentResult>>();

  constructor(
    private provider: LLMProvider,
    private model: string,
    private toolRegistry: ToolRegistry,
    private permissions: PermissionManager,
  ) {}

  launchBackground(type: SubAgentType, description: string, prompt: string): string {
    const agent = new SubAgent(
      this.provider,
      this.model,
      this.toolRegistry,
      this.permissions,
      type,
      description,
    );
    const id = agent.getAgentId();
    const promise = agent.run(prompt);
    this.runningAgents.set(id, promise);
    return id;
  }

  async launchForeground(type: SubAgentType, description: string, prompt: string): Promise<SubAgentResult> {
    const agent = new SubAgent(
      this.provider,
      this.model,
      this.toolRegistry,
      this.permissions,
      type,
      description,
    );
    return agent.run(prompt);
  }

  async launchParallel(
    tasks: Array<{ type: SubAgentType; description: string; prompt: string }>
  ): Promise<SubAgentResult[]> {
    const promises = tasks.map((task) => {
      const agent = new SubAgent(
        this.provider,
        this.model,
        this.toolRegistry,
        this.permissions,
        task.type,
        task.description,
      );
      return agent.run(task.prompt);
    });
    return Promise.allSettled(promises).then((results) =>
      results.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : {
              agentId: `failed-${i}`,
              type: tasks[i].type,
              description: tasks[i].description,
              result: `Error: ${r.reason}`,
              success: false,
            }
      )
    );
  }

  async getResult(agentId: string): Promise<SubAgentResult | null> {
    const promise = this.runningAgents.get(agentId);
    if (!promise) return null;
    const result = await promise;
    this.runningAgents.delete(agentId);
    return result;
  }

  isRunning(agentId: string): boolean {
    return this.runningAgents.has(agentId);
  }
}
