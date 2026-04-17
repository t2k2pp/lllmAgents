import chalk from "chalk";
import * as logger from "../utils/logger.js";
export class ToolExecutor {
    registry;
    permissions;
    hookManager;
    constructor(registry, permissions, hookManager) {
        this.registry = registry;
        this.permissions = permissions;
        this.hookManager = hookManager;
    }
    async execute(toolCall, source = "cli") {
        const toolName = toolCall.function.name;
        const handler = this.registry.get(toolName);
        if (!handler) {
            return {
                success: false,
                output: "",
                error: `Unknown tool: ${toolName}`,
            };
        }
        let params;
        try {
            const argsStr = toolCall.function.arguments?.trim();
            params = argsStr ? JSON.parse(argsStr) : {};
        }
        catch {
            return {
                success: false,
                output: "",
                error: `Invalid tool arguments: ${toolCall.function.arguments}`,
            };
        }
        // Permission check
        const permission = await this.permissions.checkToolPermission(toolName, params, source);
        if (!permission.allowed) {
            console.log(chalk.red(`  BLOCKED: ${permission.reason}`));
            return {
                success: false,
                output: "",
                error: permission.reason ?? "Permission denied",
                abortExecution: permission.abortExecution,
            };
        }
        // Pre-tool hooks
        if (this.hookManager) {
            const preResult = await this.hookManager.runPreToolHooks(toolName, params);
            if (!preResult.proceed) {
                logger.info(`Hook blocked tool: ${toolName}`);
                return {
                    success: false,
                    output: "",
                    error: preResult.message ?? "Blocked by pre-tool hook",
                };
            }
        }
        // Execute
        try {
            logger.debug(`Executing tool: ${toolName}`, params);
            const result = await handler.execute(params);
            // Post-tool hooks
            if (this.hookManager) {
                await this.hookManager.runPostToolHooks(toolName, params, result);
            }
            return result;
        }
        catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logger.error(`Tool execution failed: ${toolName}`, errorMsg);
            return {
                success: false,
                output: "",
                error: errorMsg,
            };
        }
    }
}
//# sourceMappingURL=tool-executor.js.map