import inquirer from "inquirer";
import chalk from "chalk";
import type { SecurityConfig } from "../config/types.js";
import type { PermissionLevel } from "./rules.js";
import { checkCommand } from "./rules.js";
import { Sandbox } from "./sandbox.js";

// ユーザーに質問する・タスク管理するなど本質的に安全なツール
// configに関わらず常にauto-approve
const INHERENTLY_SAFE_TOOLS = new Set([
  "ask_user",
  "todo_write",
  "enter_plan_mode",
  "exit_plan_mode",
  "task_output",
  "current_datetime",
]);

export class PermissionManager {
  private sandbox: Sandbox;
  private autoApprove: Set<string>;
  private requireApproval: Set<string>;
  // Session-level approvals: "tool:paramsHash" → approved
  private sessionApprovals = new Set<string>();
  // Always-allow for specific tools in this session
  private alwaysAllowTools = new Set<string>();

  constructor(config: SecurityConfig) {
    this.sandbox = new Sandbox(config);
    this.autoApprove = new Set(config.autoApproveTools);
    this.requireApproval = new Set(config.requireApprovalTools);
  }

  getPermissionLevel(toolName: string): PermissionLevel {
    if (INHERENTLY_SAFE_TOOLS.has(toolName)) return "auto";
    if (this.autoApprove.has(toolName)) return "auto";
    if (this.alwaysAllowTools.has(toolName)) return "auto";
    if (this.requireApproval.has(toolName)) return "ask";
    return "ask";
  }

  isPathAllowed(targetPath: string): boolean {
    return this.sandbox.isPathAllowed(targetPath);
  }

  async checkToolPermission(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const level = this.getPermissionLevel(toolName);

    // Auto-approve
    if (level === "auto") {
      if (toolName.startsWith("file_") || toolName === "glob" || toolName === "grep") {
        const filePath = (params.path ?? params.file_path ?? params.pattern) as string | undefined;
        if (filePath && !this.sandbox.isPathAllowed(filePath)) {
          return { allowed: false, reason: `パス ${filePath} はサンドボックス外です` };
        }
      }
      return { allowed: true };
    }

    // Deny
    if (level === "deny") {
      return { allowed: false, reason: `ツール ${toolName} は使用が禁止されています` };
    }

    // Check session approval cache
    const cacheKey = `${toolName}:${hashParams(params)}`;
    if (this.sessionApprovals.has(cacheKey)) {
      return { allowed: true };
    }

    // Check for dangerous commands
    if (toolName === "bash") {
      const command = params.command as string;
      const dangerousRule = checkCommand(command);
      if (dangerousRule) {
        if (dangerousRule.action === "block") {
          return { allowed: false, reason: dangerousRule.message };
        }
        console.log(chalk.yellow(`\n  WARNING: ${dangerousRule.message}`));
      }
    }

    // File operations: sandbox check
    if (toolName === "file_write" || toolName === "file_edit") {
      const filePath = (params.file_path ?? params.path) as string;
      if (filePath && !this.sandbox.isPathAllowed(filePath)) {
        return { allowed: false, reason: `パス ${filePath} はサンドボックス外です` };
      }
    }

    return this.askUserWithScope(toolName, params, cacheKey);
  }

  private async askUserWithScope(
    toolName: string,
    params: Record<string, unknown>,
    cacheKey: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const summary = this.formatToolSummary(toolName, params);
    console.log(chalk.cyan(`\n  [${toolName}] ${summary}`));

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: "実行を許可しますか？",
        choices: [
          { name: "許可 (今回のみ)", value: "once" },
          { name: `許可 (${toolName} をセッション中常に許可)`, value: "always" },
          { name: "拒否", value: "deny" },
        ],
      },
    ]);

    if (action === "deny") {
      return { allowed: false, reason: "ユーザーが拒否しました" };
    }

    if (action === "always") {
      this.alwaysAllowTools.add(toolName);
    } else {
      this.sessionApprovals.add(cacheKey);
    }

    return { allowed: true };
  }

  private formatToolSummary(toolName: string, params: Record<string, unknown>): string {
    switch (toolName) {
      case "bash":
        return `$ ${params.command}`;
      case "file_write":
        return `書き込み: ${params.file_path}`;
      case "file_edit":
        return `編集: ${params.file_path}`;
      case "browser_navigate":
        return `ナビゲート: ${params.url}`;
      case "browser_click":
        return `クリック: ${params.selector ?? params.ref}`;
      case "browser_type":
        return `入力: ${params.text}`;
      case "web_fetch":
        return `取得: ${params.url}`;
      case "web_search":
        return `検索: ${params.query}`;
      default:
        return JSON.stringify(params).slice(0, 120);
    }
  }
}

function hashParams(params: Record<string, unknown>): string {
  // Simple hash for caching
  const str = JSON.stringify(params);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}
