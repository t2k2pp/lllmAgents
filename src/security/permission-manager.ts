import * as path from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import type { SecurityConfig, SecurityRuleConfig } from "../config/types.js";
import type { PermissionLevel } from "./rules.js";
import { checkCommand } from "./rules.js";
import { Sandbox } from "./sandbox.js";
import { evaluateRules } from "./rule-engine.js";
import { nonTTYReader } from "../utils/non-tty-reader.js";

/** リクエストの発生元 */
export type RequestSource = "cli" | "discord" | "slack";

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
  "response_complete",
  "second_llm_consult",
]);

/**
 * 自律実行モード (autorun): 作業フォルダ配下の操作を削除以外すべて自動承認。
 * bashの破壊的コマンド（rm, del, rmdir等）とサンドボックス外パスは引き続きブロック。
 */
const AUTORUN_DESTRUCTIVE_PATTERNS = [
  /\brm\s/, /\brmdir\b/, /\bdel\b/, /\brd\b/,
  /\bunlink\b/, /\bshred\b/, /\btruncate\b/,
  /\bmkfs\b/, /\bformat\b/, /\bdd\s/,
  />\s*\/dev\//, /\bgit\s+clean\b/, /\bgit\s+reset\s+--hard\b/,
];

/**
 * bashコマンド文字列が CWD 外のパスを参照しているか判定。
 * 絶対パス（Windows/Unix）や ../ を含むパスを抽出し、cwd 配下以外を指していれば true。
 */
function referencesOutsideCwd(command: string, cwd: string): boolean {
  const absoluteWin = /[A-Za-z]:[\\/][^\s'"`|;&<>(){}]+/g;
  const absoluteUnix = /(?<![\w.\-/])\/[\w.\-/]+/g;
  const parentRef = /\.\.[\\/][\w.\-/\\]*/g;

  const candidates = [
    ...(command.match(absoluteWin) ?? []),
    ...(command.match(absoluteUnix) ?? []),
    ...(command.match(parentRef) ?? []),
  ];
  if (candidates.length === 0) return false;

  const resolvedCwd = path.resolve(cwd).toLowerCase();
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(cwd, candidate).toLowerCase();
      if (!resolved.startsWith(resolvedCwd)) return true;
    } catch {
      // 解決不能なパスは安全側に倒して true（確認が必要）
      return true;
    }
  }
  return false;
}

/**
 * 広域再帰スキャン系コマンドを検出（ls -R / find / tree / dir /s 等）。
 * これらは CWD 内でも大量出力でコンテキストを汚染するため、session-allow でも確認を挟む。
 */
function hasBroadRecursiveScan(command: string): boolean {
  if (/\bls\b[^|;&\n]*\s-[a-zA-Z]*R/.test(command)) return true;
  if (/(^|[|;&\s])find\s+[^|;&\n]+/.test(command)) return true;
  if (/(^|[|;&\s])tree\b/.test(command)) return true;
  if (/(^|[|;&\s])dir\s+[^|;&\n]*\/s\b/i.test(command)) return true;
  return false;
}

/** auto-approve されていても「都度確認」が必要な bash コマンドか判定 */
function bashNeedsExplicitAsk(command: string, cwd: string): boolean {
  return referencesOutsideCwd(command, cwd) || hasBroadRecursiveScan(command);
}

export class PermissionManager {
  private sandbox: Sandbox;
  private autoApprove: Set<string>;
  private requireApproval: Set<string>;
  private discordAutoApprove: Set<string>;
  private slackAutoApprove: Set<string>;
  private rules: SecurityRuleConfig;
  // Session-level approvals: "tool:paramsHash" → approved
  private sessionApprovals = new Set<string>();
  // Always-allow for specific tools in this session
  private alwaysAllowTools = new Set<string>();
  // Phase 5 第9ラウンド (Gate 1): ユーザーが file_edit/file_write を拒否した絶対パス。
  // 同セッション中、 同パスへの書込は再プロンプトせず即拒否する (拒否を hard barrier 化)。
  private deniedWritePaths = new Set<string>();
  // 並列ツール実行時に権限確認を直列化するキュー
  private _permissionQueue: Promise<void> = Promise.resolve();
  // 自律実行モード: 作業フォルダ内の非破壊操作を自動承認
  private _autorunMode = false;

  constructor(
    securityConfig: SecurityConfig,
    /** autoApproveToolsへの永続追加時に呼ばれるコールバック（config.json保存用） */
    private onPermanentApprove?: (tool: string) => void,
  ) {
    this.sandbox = new Sandbox(securityConfig);
    this.autoApprove = new Set(securityConfig.autoApproveTools);
    this.requireApproval = new Set(securityConfig.requireApprovalTools);
    this.discordAutoApprove = new Set(securityConfig.discordAutoApproveTools ?? []);
    this.slackAutoApprove = new Set(securityConfig.slackAutoApproveTools ?? []);
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

  getSlackAutoApproveList(): string[] {
    return [...this.slackAutoApprove].sort();
  }

  /** Slack経由で使用可能なツール名のセットを返す（INHERENTLY_SAFE_TOOLS含む） */
  getSlackAllowedToolNames(): Set<string> {
    return new Set([...INHERENTLY_SAFE_TOOLS, ...this.slackAutoApprove]);
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

  addSlackAutoApprove(tool: string): void {
    this.slackAutoApprove.add(tool);
  }

  removeSlackAutoApprove(tool: string): void {
    this.slackAutoApprove.delete(tool);
  }

  // --- 自律実行モード ---

  /** 自律実行モードの ON/OFF を切り替え */
  setAutorunMode(enabled: boolean): void {
    this._autorunMode = enabled;
  }

  isAutorunMode(): boolean {
    return this._autorunMode;
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
    // Discord/Slack: インタラクティブ確認不可のためheadlessモード
    if (source === "discord") {
      return this.checkDiscordPermission(toolName, params);
    }
    if (source === "slack") {
      return this.checkSlackPermission(toolName, params);
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

  /** Slack経由: slackAutoApproveTools + INHERENTLY_SAFE_TOOLS のみ許可 */
  private checkSlackPermission(
    toolName: string,
    params: Record<string, unknown>,
  ): { allowed: boolean; reason?: string } {
    if (evaluateRules({ allow: [], deny: this.rules.deny, ask: [] }, toolName, params) === "deny") {
      return { allowed: false, reason: `ルールにより ${toolName} はブロックされました（Slack）` };
    }

    const allowed = INHERENTLY_SAFE_TOOLS.has(toolName) || this.slackAutoApprove.has(toolName);
    if (!allowed) {
      return {
        allowed: false,
        reason: `Slack経由では ${toolName} は許可されていません（/permission slack-add ${toolName} で追加可能）`,
      };
    }

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

    // --- 自律実行モード (autorun) ---
    if (this._autorunMode && ruleResult !== "ask") {
      const autorunResult = this.checkAutorunPermission(toolName, params);
      if (autorunResult !== null) return autorunResult;
      // null → autorun では判定不能 → 通常フローへ
    }

    const level = ruleResult === "ask" ? "ask" : this.getPermissionLevel(toolName);

    // Auto-approve
    if (level === "auto") {
      if (toolName.startsWith("file_") || toolName === "glob" || toolName === "grep") {
        const filePath = (params.path ?? params.file_path ?? params.pattern) as string | undefined;
        if (filePath && !this.sandbox.isPathAllowed(filePath)) {
          return { allowed: false, reason: `パス ${filePath} はサンドボックス外です` };
        }
      }
      // bash: auto-approve でも CWD 外参照・広域再帰スキャンは確認を挟む
      if (toolName === "bash") {
        const command = (params.command as string) ?? "";
        if (bashNeedsExplicitAsk(command, process.cwd())) {
          console.log(chalk.dim(`  [CWD外参照または広域スキャンのため auto-approve をバイパスして確認]`));
          // fall through to ask flow
        } else {
          return { allowed: true };
        }
      } else {
        return { allowed: true };
      }
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
      // Phase 5 第9ラウンド (Gate 1): ユーザーが直前に拒否したパスへの書込は即拒否
      if (filePath) {
        const abs = path.resolve(filePath);
        if (this.deniedWritePaths.has(abs)) {
          console.log(chalk.yellow(`  ⛔ [auto-deny] ユーザー拒否済みパス (${abs})`));
          return {
            allowed: false,
            reason:
              `ユーザーは直前に同じパス (${filePath}) への書込を明示的に拒否しています。 ` +
              `同パスへの再試行は禁止。 ask_user で別の方針 (別パスに書く / 諦める / 内容を変える 等) を確認してから次の手を決めてください。 ` +
              `もしユーザーが拒否を撤回したいなら、 それを明示するメッセージが必要です。`,
          };
        }
      }
    }

    // browser_screenshot: save_path が指定された場合はサンドボックスチェック
    if (toolName === "browser_screenshot" && params.save_path) {
      const savePath = params.save_path as string;
      if (!this.sandbox.isPathAllowed(savePath)) {
        return { allowed: false, reason: `save_path ${savePath} はサンドボックス外です` };
      }
    }

    return this.askUserWithScope(toolName, params, cacheKey);
  }

  /**
   * 自律実行モードでの権限チェック。
   * 作業フォルダ内の非破壊操作なら自動承認。
   * 判定不能（autorunスコープ外）の場合は null を返す。
   */
  private checkAutorunPermission(
    toolName: string,
    params: Record<string, unknown>,
  ): { allowed: boolean; reason?: string } | null {
    // ファイル操作: サンドボックス内かつ削除でなければOK
    if (toolName === "file_write" || toolName === "file_edit") {
      const filePath = (params.file_path ?? params.path) as string | undefined;
      if (!filePath) return { allowed: true };
      if (!this.sandbox.isPathAllowed(filePath)) {
        return { allowed: false, reason: `[autorun] パス ${filePath} はサンドボックス外です` };
      }
      return { allowed: true };
    }

    // bash: サンドボックス内 + 非破壊コマンドならOK
    if (toolName === "bash") {
      const command = (params.command as string) ?? "";
      // 破壊的コマンドは通常の確認フローへ
      if (AUTORUN_DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) {
        return null; // 通常フローへフォールバック
      }
      // 危険コマンドチェック（既存ルール）
      const dangerousRule = checkCommand(command);
      if (dangerousRule?.action === "block") {
        return { allowed: false, reason: dangerousRule.message };
      }
      // CWD 外参照 / 広域再帰スキャンは autorun でも確認を挟む
      if (bashNeedsExplicitAsk(command, process.cwd())) {
        return null; // 通常フローへフォールバック
      }
      return { allowed: true };
    }

    // ブラウザ操作、web_fetch/web_search などその他のツール: 自動承認
    if (toolName.startsWith("browser_") || toolName === "web_fetch" || toolName === "web_search") {
      return { allowed: true };
    }

    // glob, grep 等の読み取り系: サンドボックスチェックのみ
    if (toolName === "glob" || toolName === "grep" || toolName === "file_read") {
      const filePath = (params.path ?? params.file_path ?? params.pattern) as string | undefined;
      if (filePath && !this.sandbox.isPathAllowed(filePath)) {
        return { allowed: false, reason: `[autorun] パス ${filePath} はサンドボックス外です` };
      }
      return { allowed: true };
    }

    // 未知のツール → 通常フローへ
    return null;
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
        return await this.askUserNonTTY(toolName, params, cacheKey);
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

      return this.resolvePermissionAction(action, toolName, params, cacheKey);
    } finally {
      resolveQueue();
    }
  }

  /** 非TTYモード用: NonTTYReader から1行読んでテキストメニューで選択 */
  private async askUserNonTTY(
    toolName: string,
    params: Record<string, unknown>,
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
    return this.resolvePermissionAction(action, toolName, params, cacheKey);
  }

  /** action 文字列から許可結果を返す（TTY/非TTY共通） */
  private resolvePermissionAction(
    action: string,
    toolName: string,
    params: Record<string, unknown>,
    cacheKey: string,
  ): { allowed: boolean; reason?: string; abortExecution?: boolean } {
    if (action === "abort") {
      return { allowed: false, reason: "ユーザーが中止しました", abortExecution: true };
    }
    if (action === "deny") {
      // Phase 5 第9ラウンド (Gate 1): file_edit/file_write の拒否は同パスへの hard barrier として記録
      if (toolName === "file_edit" || toolName === "file_write") {
        const filePath = (params.file_path ?? params.path) as string | undefined;
        if (filePath) {
          const abs = path.resolve(filePath);
          this.deniedWritePaths.add(abs);
          console.log(chalk.yellow(`  ⛔ ${toolName} の ${abs} 拒否を記録 (同セッション中、 同パスへの再書込は自動拒否されます)`));
        }
      }
      return {
        allowed: false,
        reason:
          `ユーザーがこの操作を明示的に拒否しました。 同じパスへの再試行は禁止。 ` +
          `「書けなかった」 のではなく「書くな」 という意思表示。 別アプローチ (別パスに書く / 諦める / 内容を変える) を取るか、 ask_user で意向確認をしてから次の手を決めてください。`,
      };
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
      case "second_llm_consult":
        return `相談:\n${params.prompt}`;
      case "second_llm_agent":
        return `委任タスク:\n${params.task}`;
      default:
        return JSON.stringify(params, null, 2);
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
