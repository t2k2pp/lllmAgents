import type { ToolCall } from "../providers/base-provider.js";
import type { ToolResult } from "../tools/tool-registry.js";
export type HookEvent = "session_start" | "session_end" | "pre_tool_use" | "post_tool_use" | "pre_compact";
export type HookHandler = (context: HookContext) => Promise<HookAction>;
export interface HookContext {
    event: HookEvent;
    toolName?: string;
    toolParams?: Record<string, unknown>;
    toolResult?: ToolResult;
    toolCall?: ToolCall;
}
export type HookAction = "continue" | "block" | "warn";
export declare class HookManager {
    private hooks;
    register(event: HookEvent, handler: HookHandler): void;
    emit(context: HookContext): Promise<HookAction>;
    hasHooks(event: HookEvent): boolean;
}
export declare const hookManager: HookManager;
//# sourceMappingURL=hooks.d.ts.map