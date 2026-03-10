import inquirer from "inquirer";
import chalk from "chalk";
import type { SecurityConfig, SecurityRuleConfig } from "../config/types.js";
import type { PermissionLevel } from "./rules.js";
import { checkCommand } from "./rules.js";
import { Sandbox } from "./sandbox.js";
import { evaluateRules } from "./rule-engine.js";
import { nonTTYReader } from "../utils/non-tty-reader.js";

/** リクエストの発生元 */
export type RequestSource = "cli" | "discord";

// ユーザーに質問する・タスク管理するなど本質的に安全なツール
// configに関わらず常にauto-approve
const INHERENTLY_SAFE_TOOLS = new Set([
  "ask_user",
  "todo_write",
  "enter_plan_mode",
  "exit_plan_mode",
  "task_output",
  "current_datetime",
  "sandbox_info",
]);

export class PermissionManager {
  private sandbox: Sandbox;
  private autoApprove: Set<string>;
  private requireApproval: Set<string>;
  private discordAutoApprove: Set<string>;
  private rules: SecurityRuleConfig;
  // Session-level approvals: "tool:paramsHash" → approved
  private sessionApprovals = new Set<string>();
  // Always-allow for specific tools in this session
  private alwaysAllowTools = new Set<string>();
  // 並列ツール実行時に権限確認を直列化するキュー
  private _permissionQueue: Promise<void> = Promise.resolve();

  constructor(
    securityConfig: SecurityConfig,
    /** autoApproveToolsへの永続追加時に呼ばれるコールバック（config.json保存用） */
    private onPermanentApprove?: (tool: string) => void,
  ) {
    this.sandbox = new Sandbox(securityConfig);
    this.autoApprove = new Set(securityConfig.autoApproveTools);
    this.requireApproval = new Set(securityConfig.requireApprovalTools);
    this.discordAutoApprove = new Set(securityConfig.discordAutoApproveTools ?? []);
    this.rules = securityConfig.rules ?? { allow: [], deny: [], ask: [] };
  }

  // --- ルール管理 ---

  getRules(): SecurityRuleConfig {
    return this.rules;
  }

  addRule(action: "allow" | "deny" | "ask", pattern: string): void {
    if (!this.rules[action].includes(pattern)) {
      this.rules[action].push(pattern);
    }
  }

  removeRule(action: "allow" | "deny" | "ask", pattern: string): void {
    this.rules[action] = this.rules[action].filter((p) => p !== pattern);
  }

  // --- 参照メソッド ---

  getAutoApproveList(): string[] {
    return [...this.autoApprove].sort();
  }

  getRequireApprovalList(): string[] {
    return [...this.requireApproval].sort();
  }

  getDiscordAutoApproveList(): string[] {
    return [...this.discordAutoApprove].sort();
  }

  /** Discord経由で使用可能なツール名のセットを返す（INHERENTLY_SAFE_TOOLS含む） */
  getDiscordAllowedToolNames(): Set<string> {
    return new Set([...INHERENTLY_SAFE_TOOLS, ...this.discordAutoApprove]);
  }

  // --- 変更メソッド（REPLの /permission コマンドから使用） ---

  addAutoApprove(tool: string): void {
    this.autoApprove.add(tool);
  }

  removeAutoApprove(tool: string): void {
    this.autoApprove.delete(tool);
  }

  addRequireApproval(tool: string): void {
    this.requireApproval.add(tool);
  }

  removeRequireApproval(tool: string): void {
    this.requireApproval.delete(tool);
  }

  addDiscordAutoApprove(tool: string): void {
    this.discordAutoApprove.add(tool);
  }

  removeDiscordAutoApprove(tool: string): void {
    this.discordAutoApprove.delete(tool);
  }

  // ---

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

  addAllowedDir(dir: string): void {
    this.sandbox.addAllowedDir(dir);
  }

  async checkToolPermission(
    toolName: string,
    params: Record<string, unknown>,
    source: RequestSource = "cli",
  ): Promise<{ allowed: boolean; reason?: string; abortExecution?: boolean }> {
    // Discord: インタラクティブ確認不可のためheadlessモード
    if (source === "discord") {
      return this.checkDiscordPermission(toolName, params);
    }

    // CLI: 通常の確認フロー
    return this.checkCliPermission(toolName, params);
  }

  /** Discord経由: discordAutoApproveTools + INHERENTLY_SAFE_TOOLS のみ許可 */
  private checkDiscordPermission(
    toolName: string,
    params: Record<string, unknown>,
  ): { allowed: boolean; reason?: string } {
    // denyルールは Discord でも有効（セキュリティ上の強制）
    if (evaluateRules({ allow: [], deny: this.rules.deny, ask: [] }, toolName, params) === "deny") {
      return { allowed: false, reason: `ルールにより ${toolName} はブロックされました（Discord）` };
    }

    const allowed = INHERENTLY_SAFE_TOOLS.has(toolName) || this.discordAutoApprove.has(toolName);
    if (!allowed) {
      return {
        allowed: false,
        reason: `Discord経由では ${toolName} は許可されていません（/permission discord-add ${toolName} で追加可能）`,
      };
    }

    // ファイル操作はサンドボックスチェック
    if (toolName.startsWith("file_") || toolName === "glob" || toolName === "grep") {
      const filePath = (params.path ?? params.file_path ?? params.pattern) as string | undefined;
      if (filePath && !this.sandbox.isPathAllowed(filePath)) {
        return { allowed: false, reason: `パス ${filePath} はサンドボックス外です` };
      }
    }

    return { allowed: true };
  }

  /** CLI経由: 従来の確認フロー */
  private async checkCliPermission(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string; abortExecution?: boolean }> {
    // パターンルール評価（ツール名リストより優先）
    const ruleResult = evaluateRules(this.rules, toolName, params);
    if (ruleResult === "deny") {
      return { allowed: false, reason: `ルールにより ${toolName} はブロックされました` };
    }
    if (ruleResult === "allow") {
      return { allowed: true };
    }
    // ruleResult === "ask" の場合はそのまま確認ダイアログへ進む
    // ruleResult === null の場合はツール名リストで判定

    const level = ruleResult === "ask" ? "ask" : this.getPermissionLevel(toolName);

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
  ): Promise<{ allowed: boolean; reason?: string; abortExecution?: boolean }> {
    // 並列ツール実行時でも確認を1件ずつ直列化する
    let resolveQueue!: () => void;
    const prev = this._permissionQueue;
    this._permissionQueue = new Promise<void>((r) => { resolveQueue = r; });
    await prev;

    try {
      const summary = this.formatToolSummary(toolName, params);
      console.log(chalk.cyan(`\n  [${toolName}] ${summary}`));

      // 非TTYモード（パイプ等）: readline テキストメニューにフォールバック
      if (!process.stdin.isTTY) {
        return await this.askUserNonTTY(toolName, cacheKey);
      }

      // TTYモード: inquirer インタラクティブリスト
      let action: string;
      try {
        const result = await inquirer.prompt<{ action: string }>([
          {
            type: "list",
            name: "action",
            message: "実行を許可しますか？",
            choices: [
              { name: "許可 (今回のみ)", value: "once" },
              { name: `許可 (${toolName} をセッション中常に許可)`, value: "always" },
              { name: `許可 (${toolName} を設定に保存して常に許可)`, value: "permanent" },
              { name: "拒否", value: "deny" },
              { name: "中止 (Agentを中断してプロンプトに戻る)", value: "abort" },
            ],
          },
        ]);
        action = result.action;
      } catch (e) {
        // stdinが閉じられた場合などのフォールバック
        if (e instanceof Error && (e.constructor.name === "ExitPromptError" || e.message.includes("force closed"))) {
          console.log(chalk.yellow("  (入力が閉じられたため中止)"));
          return { allowed: false, abortExecution: true };
        }
        throw e;
      }

      return this.resolvePermissionAction(action, toolName, cacheKey);
    } finally {
      resolveQueue();
    }
  }

  /** 非TTYモード用: NonTTYReader から1行読んでテキストメニューで選択 */
  private async askUserNonTTY(
    toolName: string,
    cacheKey: string,
  ): Promise<{ allowed: boolean; reason?: string; abortExecution?: boolean }> {
    process.stdout.write(
      `  1: 許可 (今回のみ)\n` +
      `  2: 許可 (${toolName} をセッション中常に許可)\n` +
      `  3: 許可 (${toolName} を設定に保存して常に許可)\n` +
      `  4: 拒否\n` +
      `  5: 中止\n` +
      `選択 [1-5]: `,
    );

    const answer = await nonTTYReader.readLine();

    const actionMap: Record<string, string> = {
      "1": "once", "2": "always", "3": "permanent", "4": "deny", "5": "abort",
    };
    const action = actionMap[answer] ?? "abort";
    return this.resolvePermissionAction(action, toolName, cacheKey);
  }

  /** action 文字列から許可結果を返す（TTY/非TTY共通） */
  private resolvePermissionAction(
    action: string,
    toolName: string,
    cacheKey: string,
  ): { allowed: boolean; reason?: string; abortExecution?: boolean } {
    if (action === "abort") {
      return { allowed: false, reason: "ユーザーが中止しました", abortExecution: true };
    }
    if (action === "deny") {
      return { allowed: false, reason: "ユーザーが拒否しました" };
    }
    if (action === "permanent") {
      this.autoApprove.add(toolName);
      if (this.onPermanentApprove) {
        this.onPermanentApprove(toolName);
      }
      console.log(chalk.green(`  ✅ ${toolName} を設定に保存しました（/permission auto-remove ${toolName} で取り消し可能）`));
    } else if (action === "always") {
      this.alwaysAllowTools.add(toolName);
    } else {
      // "once"
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
