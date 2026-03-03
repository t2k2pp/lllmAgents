import chalk from "chalk";
import type { ToolCall } from "../providers/base-provider.js";
import type { ToolRegistry, ToolResult } from "./tool-registry.js";
import type { PermissionManager } from "../security/permission-manager.js";
import type { HookManager } from "../hooks/hook-manager.js";
import * as logger from "../utils/logger.js";

export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private permissions: PermissionManager,
    private hookManager?: HookManager,
  ) {}

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    const handler = this.registry.get(toolName);

    if (!handler) {
      return {
        success: false,
        output: "",
        error: `Unknown tool: ${toolName}`,
      };
    }

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(toolCall.function.arguments);
    } catch {
      return {
        success: false,
        output: "",
        error: `Invalid tool arguments: ${toolCall.function.arguments}`,
      };
    }

    // Permission check
    const permission = await this.permissions.checkToolPermission(toolName, params);
    if (!permission.allowed) {
      console.log(chalk.red(`  BLOCKED: ${permission.reason}`));
      return {
        success: false,
        output: "",
        error: permission.reason ?? "Permission denied",
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
    } catch (e) {
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
