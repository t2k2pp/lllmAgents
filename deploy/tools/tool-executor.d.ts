import type { ToolCall } from "../providers/base-provider.js";
import type { ToolRegistry, ToolResult } from "./tool-registry.js";
import type { PermissionManager, RequestSource } from "../security/permission-manager.js";
import type { HookManager } from "../hooks/hook-manager.js";
export declare class ToolExecutor {
    private registry;
    private permissions;
    private hookManager?;
    constructor(registry: ToolRegistry, permissions: PermissionManager, hookManager?: HookManager | undefined);
    execute(toolCall: ToolCall, source?: RequestSource): Promise<ToolResult>;
}
//# sourceMappingURL=tool-executor.d.ts.map