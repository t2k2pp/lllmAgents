import inquirer from "inquirer";
import chalk from "chalk";
import type { SecurityConfig } from "../config/types.js";
import type { PermissionLevel } from "./rules.js";
import { checkCommand } from "./rules.js";
import { Sandbox } from "./sandbox.js";

export class PermissionManager {
  private sandbox: Sandbox;
  private autoApprove: Set<string>;
  private requireApproval: Set<string>;
  constructor(config: SecurityConfig) {
    this.sandbox = new Sandbox(config);
    this.autoApprove = new Set(config.autoApproveTools);
    this.requireApproval = new Set(config.requireApprovalTools);
  }

  getPermissionLevel(toolName: string): PermissionLevel {
    if (this.autoApprove.has(toolName)) return "auto";
    if (this.requireApproval.has(toolName)) return "ask";
    return "ask"; // Default: ask
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
      // Still check sandbox for file operations
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

    // Ask: check for dangerous commands
    if (toolName === "bash") {
      const command = params.command as string;
      const dangerousRule = checkCommand(command);
      if (dangerousRule) {
        if (dangerousRule.action === "block") {
          return { allowed: false, reason: dangerousRule.message };
        }
        // Warn: show warning and ask
        console.log(chalk.yellow(`\n  WARNING: ${dangerousRule.message}`));
      }
    }

    // File operations: check sandbox
    if (toolName === "file_write" || toolName === "file_edit") {
      const filePath = (params.file_path ?? params.path) as string;
      if (filePath && !this.sandbox.isPathAllowed(filePath)) {
        return { allowed: false, reason: `パス ${filePath} はサンドボックス外です` };
      }
    }

    // Ask user
    return this.askUser(toolName, params);
  }

  private async askUser(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const summary = this.formatToolSummary(toolName, params);
    console.log(chalk.cyan(`\n  [${toolName}] ${summary}`));

    const { approved } = await inquirer.prompt<{ approved: boolean }>([
      {
        type: "confirm",
        name: "approved",
        message: "実行しますか？",
        default: true,
      },
    ]);

    if (!approved) {
      return { allowed: false, reason: "ユーザーが拒否しました" };
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
      default:
        return JSON.stringify(params).slice(0, 100);
    }
  }
}
