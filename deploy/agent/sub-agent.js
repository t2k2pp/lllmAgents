import { ToolRegistry } from "../tools/tool-registry.js";
import { MessageHistory } from "./message-history.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { collectResponse } from "../providers/base-provider.js";
import { AgentDefinitionLoader } from "../agents/agent-loader.js";
import * as logger from "../utils/logger.js";
const MAX_SUB_ITERATIONS = 30;
// Hardcoded fallback configs for backward compatibility
const FALLBACK_CONFIGS = {
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
let sharedLoader = null;
/** テキストに7行以上のコードブロックが含まれているか検出する */
function hasLargeCodeBlock(text) {
    const matches = text.match(/```[\s\S]*?```/g);
    if (!matches)
        return false;
    return matches.some((block) => block.split("\n").length >= 7);
}
/** モデルがfile_writeをJSONコードブロックで「説明」した場合に抽出する */
function extractFakeFileWriteCalls(text) {
    const results = [];
    const jsonBlockRegex = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = jsonBlockRegex.exec(text)) !== null) {
        try {
            const obj = JSON.parse(match[1]);
            if (typeof obj.file_path === "string" && typeof obj.content === "string") {
                results.push({ file_path: obj.file_path, content: obj.content });
            }
        }
        catch { /* JSON パース失敗は無視 */ }
    }
    return results;
}
function getLoader() {
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
function resolveAgentConfig(type) {
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
function agentDefToConfig(def) {
    return {
        type: def.name,
        systemPrompt: def.systemPrompt,
        allowedTools: def.allowedTools.length > 0 ? def.allowedTools : undefined,
    };
}
export class SubAgent {
    provider;
    model;
    agentId;
    history;
    toolExecutor;
    filteredRegistry;
    config;
    constructor(provider, model, toolRegistry, permissions, type, description, overrides) {
        this.provider = provider;
        this.model = model;
        this.agentId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const resolved = resolveAgentConfig(type);
        if (!resolved) {
            throw new Error(`Unknown sub-agent type: '${type}'. No definition file or fallback found.`);
        }
        this.config = {
            ...resolved,
            description,
            ...(overrides?.systemPrompt !== undefined && { systemPrompt: overrides.systemPrompt }),
            ...(overrides?.allowedTools !== undefined && { allowedTools: overrides.allowedTools }),
            ...(overrides?.maxTurns !== undefined && { maxTurns: overrides.maxTurns }),
        };
        this.filteredRegistry = this.createFilteredRegistry(toolRegistry, this.config);
        this.history = new MessageHistory(this.config.systemPrompt);
        this.toolExecutor = new ToolExecutor(this.filteredRegistry, permissions);
    }
    createFilteredRegistry(registry, config) {
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
            if (name === "task")
                continue;
            const handler = registry.get(name);
            if (handler) {
                filtered.register(handler);
            }
        }
        return filtered;
    }
    async run(prompt) {
        this.history.addUserMessage(prompt);
        const maxTurns = this.config.maxTurns ?? MAX_SUB_ITERATIONS;
        let finalResult = "";
        let codeBlockRetried = false;
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
                // コードブロックをテキストで返した場合のリプロンプト（file_write未使用検出）
                if (!codeBlockRetried && hasLargeCodeBlock(response.content)) {
                    codeBlockRetried = true;
                    this.history.addAssistantMessage(response.content);
                    this.history.addUserMessage("コードをテキストで返しましたが、実際にファイルを作成してください。" +
                        "file_writeツールを呼び出して、指定されたパスにファイルを保存してください。" +
                        "コードをチャットに書くのではなく、必ずfile_writeツールを使用してください。");
                    continue;
                }
                // リプロンプト後もJSONコードブロックで返した場合は直接実行
                if (codeBlockRetried) {
                    const fakeWrites = extractFakeFileWriteCalls(response.content);
                    if (fakeWrites.length > 0) {
                        this.history.addAssistantMessage(response.content);
                        for (const fw of fakeWrites) {
                            const syntheticCall = {
                                id: `synthetic_fw_${Date.now()}`,
                                type: "function",
                                function: { name: "file_write", arguments: JSON.stringify(fw) },
                            };
                            const result = await this.toolExecutor.execute(syntheticCall);
                            const resultContent = result.success
                                ? result.output
                                : `Error: ${result.error}\n${result.output}`;
                            this.history.addToolResult(syntheticCall.id, resultContent);
                        }
                        this.history.addUserMessage("ファイルの作成が完了しました。作業の結果を報告してください。");
                        continue;
                    }
                }
                this.history.addAssistantMessage(response.content);
                finalResult = response.content;
                break;
            }
            catch (e) {
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
    getAgentId() {
        return this.agentId;
    }
}
export class SubAgentManager {
    provider;
    model;
    toolRegistry;
    permissions;
    runningAgents = new Map();
    constructor(provider, model, toolRegistry, permissions) {
        this.provider = provider;
        this.model = model;
        this.toolRegistry = toolRegistry;
        this.permissions = permissions;
    }
    launchBackground(type, description, prompt) {
        const agent = new SubAgent(this.provider, this.model, this.toolRegistry, this.permissions, type, description);
        const id = agent.getAgentId();
        const promise = agent.run(prompt);
        this.runningAgents.set(id, promise);
        return id;
    }
    async launchForeground(type, description, prompt) {
        const agent = new SubAgent(this.provider, this.model, this.toolRegistry, this.permissions, type, description);
        return agent.run(prompt);
    }
    async launchParallel(tasks) {
        const promises = tasks.map((task) => {
            const agent = new SubAgent(this.provider, this.model, this.toolRegistry, this.permissions, task.type, task.description);
            return agent.run(task.prompt);
        });
        return Promise.allSettled(promises).then((results) => results.map((r, i) => r.status === "fulfilled"
            ? r.value
            : {
                agentId: `failed-${i}`,
                type: tasks[i].type,
                description: tasks[i].description,
                result: `Error: ${r.reason}`,
                success: false,
            }));
    }
    /**
     * スキルのcontext:fork用: スキル内容をsystemPromptとしてSubAgentを起動する。
     * スキルの指示を独立したコンテキストで実行し、メインコンテキストを汚染しない。
     */
    async launchSkillFork(skillName, skillSystemPrompt, allowedTools, prompt) {
        const agent = new SubAgent(this.provider, this.model, this.toolRegistry, this.permissions, "general-purpose", `skill:${skillName}`, { systemPrompt: skillSystemPrompt, allowedTools });
        return agent.run(prompt);
    }
    async getResult(agentId) {
        const promise = this.runningAgents.get(agentId);
        if (!promise)
            return null;
        const result = await promise;
        this.runningAgents.delete(agentId);
        return result;
    }
    isRunning(agentId) {
        return this.runningAgents.has(agentId);
    }
}
//# sourceMappingURL=sub-agent.js.map