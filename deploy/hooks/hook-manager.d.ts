import type { ToolResult } from "../tools/tool-registry.js";
export type HookType = "PreToolUse" | "PostToolUse" | "SessionStart" | "SessionStop";
export interface HookMatcher {
    tool?: string;
    filePattern?: string;
}
export interface HookDefinition {
    type: HookType;
    matcher?: HookMatcher;
    command: string;
    description?: string;
}
export interface HooksFile {
    hooks: HookDefinition[];
}
export interface PreHookResult {
    proceed: boolean;
    message?: string;
}
export declare class HookManager {
    private hooks;
    private loaded;
    /**
     * Load hooks from all sources (project-local and user-global).
     * Later sources are appended; all matching hooks run in order.
     */
    loadHooks(projectDir?: string): void;
    /**
     * Run all matching PreToolUse hooks.
     * If any hook command exits with a non-zero code, execution is blocked.
     */
    runPreToolHooks(toolName: string, params: Record<string, unknown>): Promise<PreHookResult>;
    /**
     * Run all matching PostToolUse hooks.
     */
    runPostToolHooks(toolName: string, params: Record<string, unknown>, result: ToolResult): Promise<void>;
    /**
     * Run SessionStart or SessionStop hooks.
     */
    runSessionHooks(type: "start" | "stop"): Promise<void>;
    /** Return the number of loaded hooks. */
    get count(): number;
    /** Whether hooks have been loaded at least once. */
    get isLoaded(): boolean;
    private loadFromFile;
    /** Get hooks matching a given type, tool name, and params. */
    private getMatching;
    /** Build environment variables for hook commands. */
    private buildEnv;
    /** Extract a file path from tool params (best effort). */
    private extractFilePath;
}
//# sourceMappingURL=hook-manager.d.ts.map