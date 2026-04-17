import inquirer from "inquirer";
import chalk from "chalk";
import { checkCommand } from "./rules.js";
import { Sandbox } from "./sandbox.js";
import { evaluateRules } from "./rule-engine.js";
import { nonTTYReader } from "../utils/non-tty-reader.js";
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
export class PermissionManager {
    onPermanentApprove;
    sandbox;
    autoApprove;
    requireApproval;
    discordAutoApprove;
    slackAutoApprove;
    rules;
    // Session-level approvals: "tool:paramsHash" → approved
    sessionApprovals = new Set();
    // Always-allow for specific tools in this session
    alwaysAllowTools = new Set();
    // 並列ツール実行時に権限確認を直列化するキュー
    _permissionQueue = Promise.resolve();
    // 自律実行モード: 作業フォルダ内の非破壊操作を自動承認
    _autorunMode = false;
    constructor(securityConfig, 
    /** autoApproveToolsへの永続追加時に呼ばれるコールバック（config.json保存用） */
    onPermanentApprove) {
        this.onPermanentApprove = onPermanentApprove;
        this.sandbox = new Sandbox(securityConfig);
        this.autoApprove = new Set(securityConfig.autoApproveTools);
        this.requireApproval = new Set(securityConfig.requireApprovalTools);
        this.discordAutoApprove = new Set(securityConfig.discordAutoApproveTools ?? []);
        this.slackAutoApprove = new Set(securityConfig.slackAutoApproveTools ?? []);
        this.rules = securityConfig.rules ?? { allow: [], deny: [], ask: [] };
    }
    // --- ルール管理 ---
    getRules() {
        return this.rules;
    }
    addRule(action, pattern) {
        if (!this.rules[action].includes(pattern)) {
            this.rules[action].push(pattern);
        }
    }
    removeRule(action, pattern) {
        this.rules[action] = this.rules[action].filter((p) => p !== pattern);
    }
    // --- 参照メソッド ---
    getAutoApproveList() {
        return [...this.autoApprove].sort();
    }
    getRequireApprovalList() {
        return [...this.requireApproval].sort();
    }
    getDiscordAutoApproveList() {
        return [...this.discordAutoApprove].sort();
    }
    /** Discord経由で使用可能なツール名のセットを返す（INHERENTLY_SAFE_TOOLS含む） */
    getDiscordAllowedToolNames() {
        return new Set([...INHERENTLY_SAFE_TOOLS, ...this.discordAutoApprove]);
    }
    getSlackAutoApproveList() {
        return [...this.slackAutoApprove].sort();
    }
    /** Slack経由で使用可能なツール名のセットを返す（INHERENTLY_SAFE_TOOLS含む） */
    getSlackAllowedToolNames() {
        return new Set([...INHERENTLY_SAFE_TOOLS, ...this.slackAutoApprove]);
    }
    // --- 変更メソッド（REPLの /permission コマンドから使用） ---
    addAutoApprove(tool) {
        this.autoApprove.add(tool);
    }
    removeAutoApprove(tool) {
        this.autoApprove.delete(tool);
    }
    addRequireApproval(tool) {
        this.requireApproval.add(tool);
    }
    removeRequireApproval(tool) {
        this.requireApproval.delete(tool);
    }
    addDiscordAutoApprove(tool) {
        this.discordAutoApprove.add(tool);
    }
    removeDiscordAutoApprove(tool) {
        this.discordAutoApprove.delete(tool);
    }
    addSlackAutoApprove(tool) {
        this.slackAutoApprove.add(tool);
    }
    removeSlackAutoApprove(tool) {
        this.slackAutoApprove.delete(tool);
    }
    // --- 自律実行モード ---
    /** 自律実行モードの ON/OFF を切り替え */
    setAutorunMode(enabled) {
        this._autorunMode = enabled;
    }
    isAutorunMode() {
        return this._autorunMode;
    }
    // ---
    getPermissionLevel(toolName) {
        if (INHERENTLY_SAFE_TOOLS.has(toolName))
            return "auto";
        if (this.autoApprove.has(toolName))
            return "auto";
        if (this.alwaysAllowTools.has(toolName))
            return "auto";
        if (this.requireApproval.has(toolName))
            return "ask";
        return "ask";
    }
    isPathAllowed(targetPath) {
        return this.sandbox.isPathAllowed(targetPath);
    }
    addAllowedDir(dir) {
        this.sandbox.addAllowedDir(dir);
    }
    async checkToolPermission(toolName, params, source = "cli") {
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
    checkDiscordPermission(toolName, params) {
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
            const filePath = (params.path ?? params.file_path ?? params.pattern);
            if (filePath && !this.sandbox.isPathAllowed(filePath)) {
                return { allowed: false, reason: `パス ${filePath} はサンドボックス外です` };
            }
        }
        return { allowed: true };
    }
    /** Slack経由: slackAutoApproveTools + INHERENTLY_SAFE_TOOLS のみ許可 */
    checkSlackPermission(toolName, params) {
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
            const filePath = (params.path ?? params.file_path ?? params.pattern);
            if (filePath && !this.sandbox.isPathAllowed(filePath)) {
                return { allowed: false, reason: `パス ${filePath} はサンドボックス外です` };
            }
        }
        return { allowed: true };
    }
    /** CLI経由: 従来の確認フロー */
    async checkCliPermission(toolName, params) {
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
            if (autorunResult !== null)
                return autorunResult;
            // null → autorun では判定不能 → 通常フローへ
        }
        const level = ruleResult === "ask" ? "ask" : this.getPermissionLevel(toolName);
        // Auto-approve
        if (level === "auto") {
            if (toolName.startsWith("file_") || toolName === "glob" || toolName === "grep") {
                const filePath = (params.path ?? params.file_path ?? params.pattern);
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
            const command = params.command;
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
            const filePath = (params.file_path ?? params.path);
            if (filePath && !this.sandbox.isPathAllowed(filePath)) {
                return { allowed: false, reason: `パス ${filePath} はサンドボックス外です` };
            }
        }
        // browser_screenshot: save_path が指定された場合はサンドボックスチェック
        if (toolName === "browser_screenshot" && params.save_path) {
            const savePath = params.save_path;
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
    checkAutorunPermission(toolName, params) {
        // ファイル操作: サンドボックス内かつ削除でなければOK
        if (toolName === "file_write" || toolName === "file_edit") {
            const filePath = (params.file_path ?? params.path);
            if (!filePath)
                return { allowed: true };
            if (!this.sandbox.isPathAllowed(filePath)) {
                return { allowed: false, reason: `[autorun] パス ${filePath} はサンドボックス外です` };
            }
            return { allowed: true };
        }
        // bash: サンドボックス内 + 非破壊コマンドならOK
        if (toolName === "bash") {
            const command = params.command ?? "";
            // 破壊的コマンドは通常の確認フローへ
            if (AUTORUN_DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) {
                return null; // 通常フローへフォールバック
            }
            // 危険コマンドチェック（既存ルール）
            const dangerousRule = checkCommand(command);
            if (dangerousRule?.action === "block") {
                return { allowed: false, reason: dangerousRule.message };
            }
            return { allowed: true };
        }
        // ブラウザ操作、web_fetch/web_search などその他のツール: 自動承認
        if (toolName.startsWith("browser_") || toolName === "web_fetch" || toolName === "web_search") {
            return { allowed: true };
        }
        // glob, grep 等の読み取り系: サンドボックスチェックのみ
        if (toolName === "glob" || toolName === "grep" || toolName === "file_read") {
            const filePath = (params.path ?? params.file_path ?? params.pattern);
            if (filePath && !this.sandbox.isPathAllowed(filePath)) {
                return { allowed: false, reason: `[autorun] パス ${filePath} はサンドボックス外です` };
            }
            return { allowed: true };
        }
        // 未知のツール → 通常フローへ
        return null;
    }
    async askUserWithScope(toolName, params, cacheKey) {
        // 並列ツール実行時でも確認を1件ずつ直列化する
        let resolveQueue;
        const prev = this._permissionQueue;
        this._permissionQueue = new Promise((r) => { resolveQueue = r; });
        await prev;
        try {
            const summary = this.formatToolSummary(toolName, params);
            console.log(chalk.cyan(`\n  [${toolName}] ${summary}`));
            // 非TTYモード（パイプ等）: readline テキストメニューにフォールバック
            if (!process.stdin.isTTY) {
                return await this.askUserNonTTY(toolName, cacheKey);
            }
            // TTYモード: inquirer インタラクティブリスト
            let action;
            try {
                const result = await inquirer.prompt([
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
            }
            catch (e) {
                // stdinが閉じられた場合などのフォールバック
                if (e instanceof Error && (e.constructor.name === "ExitPromptError" || e.message.includes("force closed"))) {
                    console.log(chalk.yellow("  (入力が閉じられたため中止)"));
                    return { allowed: false, abortExecution: true };
                }
                throw e;
            }
            return this.resolvePermissionAction(action, toolName, cacheKey);
        }
        finally {
            resolveQueue();
        }
    }
    /** 非TTYモード用: NonTTYReader から1行読んでテキストメニューで選択 */
    async askUserNonTTY(toolName, cacheKey) {
        process.stdout.write(`  1: 許可 (今回のみ)\n` +
            `  2: 許可 (${toolName} をセッション中常に許可)\n` +
            `  3: 許可 (${toolName} を設定に保存して常に許可)\n` +
            `  4: 拒否\n` +
            `  5: 中止\n` +
            `選択 [1-5]: `);
        const answer = await nonTTYReader.readLine();
        const actionMap = {
            "1": "once", "2": "always", "3": "permanent", "4": "deny", "5": "abort",
        };
        const action = actionMap[answer] ?? "abort";
        return this.resolvePermissionAction(action, toolName, cacheKey);
    }
    /** action 文字列から許可結果を返す（TTY/非TTY共通） */
    resolvePermissionAction(action, toolName, cacheKey) {
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
        }
        else if (action === "always") {
            this.alwaysAllowTools.add(toolName);
        }
        else {
            // "once"
            this.sessionApprovals.add(cacheKey);
        }
        return { allowed: true };
    }
    formatToolSummary(toolName, params) {
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
function hashParams(params) {
    // Simple hash for caching
    const str = JSON.stringify(params);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash + char) | 0;
    }
    return hash.toString(36);
}
//# sourceMappingURL=permission-manager.js.map