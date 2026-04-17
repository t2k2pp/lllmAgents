import type { LLMProvider } from "../providers/base-provider.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { PermissionManager } from "../security/permission-manager.js";
export type SubAgentType = "explore" | "plan" | "general-purpose" | "bash" | (string & {});
export interface SubAgentResult {
    agentId: string;
    type: SubAgentType;
    description: string;
    result: string;
    success: boolean;
}
/** スキルのcontext:forkで使用するカスタム設定のオーバーライド */
export interface SubAgentConfigOverrides {
    systemPrompt?: string;
    allowedTools?: string[];
    maxTurns?: number;
}
export declare class SubAgent {
    private provider;
    private model;
    private agentId;
    private history;
    private toolExecutor;
    private filteredRegistry;
    private config;
    constructor(provider: LLMProvider, model: string, toolRegistry: ToolRegistry, permissions: PermissionManager, type: SubAgentType, description: string, overrides?: SubAgentConfigOverrides);
    private createFilteredRegistry;
    run(prompt: string): Promise<SubAgentResult>;
    getAgentId(): string;
}
export declare class SubAgentManager {
    private provider;
    private model;
    private toolRegistry;
    private permissions;
    private runningAgents;
    constructor(provider: LLMProvider, model: string, toolRegistry: ToolRegistry, permissions: PermissionManager);
    launchBackground(type: SubAgentType, description: string, prompt: string): string;
    launchForeground(type: SubAgentType, description: string, prompt: string): Promise<SubAgentResult>;
    launchParallel(tasks: Array<{
        type: SubAgentType;
        description: string;
        prompt: string;
    }>): Promise<SubAgentResult[]>;
    /**
     * スキルのcontext:fork用: スキル内容をsystemPromptとしてSubAgentを起動する。
     * スキルの指示を独立したコンテキストで実行し、メインコンテキストを汚染しない。
     */
    launchSkillFork(skillName: string, skillSystemPrompt: string, allowedTools: string[] | undefined, prompt: string): Promise<SubAgentResult>;
    getResult(agentId: string): Promise<SubAgentResult | null>;
    isRunning(agentId: string): boolean;
}
//# sourceMappingURL=sub-agent.d.ts.map