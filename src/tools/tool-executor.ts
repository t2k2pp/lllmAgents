import chalk from "chalk";
import type { ToolCall } from "../providers/base-provider.js";
import type { ToolRegistry, ToolResult } from "./tool-registry.js";
import type { PermissionManager, RequestSource } from "../security/permission-manager.js";
import { formatToolSummary } from "../security/permission-manager.js";
import type { HookManager } from "../hooks/hook-manager.js";
import { ROOT_ANCESTORS, type AncestorTypes } from "../agent/delegation-context.js";
import { validateAgainstSchema, formatValidationError } from "./schema-validator.js";
import { progressIndicator } from "../cli/progress-indicator.js";
import * as logger from "../utils/logger.js";

export class ToolExecutor {
  /**
   * 委任階層トラッキング (D1)。 メインなら ROOT_ANCESTORS、 SubAgent / SecondLLMManager
   * が ToolExecutor を生成するときは祖先 ∪ {sub|second} を渡す。 task / second_llm_*
   * のハンドラはこの値を context.ancestors として受け取り、 子エージェントに伝播させる。
   */
  private readonly ancestors: AncestorTypes;

  constructor(
    private registry: ToolRegistry,
    private permissions: PermissionManager,
    private hookManager?: HookManager,
    ancestors: AncestorTypes = ROOT_ANCESTORS,
  ) {
    this.ancestors = ancestors;
  }

  async execute(toolCall: ToolCall, source: RequestSource = "cli"): Promise<ToolResult> {
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
      const argsStr = toolCall.function.arguments?.trim();
      params = argsStr ? JSON.parse(argsStr) : {};
    } catch {
      return {
        success: false,
        output: "",
        error: `Invalid tool arguments: ${toolCall.function.arguments}`,
      };
    }

    // Phase E-4: Schema-strict validation — required / type / enum を実行前にチェック
    // 違反時は具体的な error を返してモデルに学習させる (T3 で特に効果大)
    try {
      const parameters = handler.definition.function.parameters;
      const validation = validateAgainstSchema(parameters, params);
      if (!validation.valid) {
        return {
          success: false,
          output: "",
          error: formatValidationError(toolName, validation.errors),
        };
      }
    } catch (e) {
      // schema 自体が壊れているケース → tool 開発時のバグなので debug ログだけ残して通過
      logger.debug(`Schema validation skipped for ${toolName} due to: ${e}`);
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
    // 進捗インジケータ: 1 秒経過したら spinner で経過時間を表示。
    // root (= main) 経路のみで描画して、 サブエージェント実行内の重複表示を防ぐ。
    const isRoot = this.ancestors === ROOT_ANCESTORS;
    if (isRoot) {
      progressIndicator.begin(toolName, formatToolSummary(toolName, params));
    }
    try {
      logger.debug(`Executing tool: ${toolName}`, params);
      const result = await handler.execute(params, { ancestors: this.ancestors });

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
    } finally {
      if (isRoot) {
        progressIndicator.end();
      }
    }
  }
}
