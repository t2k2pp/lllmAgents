import type { SecurityConfig, SecurityRuleConfig } from "../config/types.js";
import type { PermissionLevel } from "./rules.js";
/** リクエストの発生元 */
export type RequestSource = "cli" | "discord" | "slack";
export declare class PermissionManager {
    /** autoApproveToolsへの永続追加時に呼ばれるコールバック（config.json保存用） */
    private onPermanentApprove?;
    private sandbox;
    private autoApprove;
    private requireApproval;
    private discordAutoApprove;
    private slackAutoApprove;
    private rules;
    private sessionApprovals;
    private alwaysAllowTools;
    private _permissionQueue;
    private _autorunMode;
    constructor(securityConfig: SecurityConfig, 
    /** autoApproveToolsへの永続追加時に呼ばれるコールバック（config.json保存用） */
    onPermanentApprove?: ((tool: string) => void) | undefined);
    getRules(): SecurityRuleConfig;
    addRule(action: "allow" | "deny" | "ask", pattern: string): void;
    removeRule(action: "allow" | "deny" | "ask", pattern: string): void;
    getAutoApproveList(): string[];
    getRequireApprovalList(): string[];
    getDiscordAutoApproveList(): string[];
    /** Discord経由で使用可能なツール名のセットを返す（INHERENTLY_SAFE_TOOLS含む） */
    getDiscordAllowedToolNames(): Set<string>;
    getSlackAutoApproveList(): string[];
    /** Slack経由で使用可能なツール名のセットを返す（INHERENTLY_SAFE_TOOLS含む） */
    getSlackAllowedToolNames(): Set<string>;
    addAutoApprove(tool: string): void;
    removeAutoApprove(tool: string): void;
    addRequireApproval(tool: string): void;
    removeRequireApproval(tool: string): void;
    addDiscordAutoApprove(tool: string): void;
    removeDiscordAutoApprove(tool: string): void;
    addSlackAutoApprove(tool: string): void;
    removeSlackAutoApprove(tool: string): void;
    /** 自律実行モードの ON/OFF を切り替え */
    setAutorunMode(enabled: boolean): void;
    isAutorunMode(): boolean;
    getPermissionLevel(toolName: string): PermissionLevel;
    isPathAllowed(targetPath: string): boolean;
    addAllowedDir(dir: string): void;
    checkToolPermission(toolName: string, params: Record<string, unknown>, source?: RequestSource): Promise<{
        allowed: boolean;
        reason?: string;
        abortExecution?: boolean;
    }>;
    /** Discord経由: discordAutoApproveTools + INHERENTLY_SAFE_TOOLS のみ許可 */
    private checkDiscordPermission;
    /** Slack経由: slackAutoApproveTools + INHERENTLY_SAFE_TOOLS のみ許可 */
    private checkSlackPermission;
    /** CLI経由: 従来の確認フロー */
    private checkCliPermission;
    /**
     * 自律実行モードでの権限チェック。
     * 作業フォルダ内の非破壊操作なら自動承認。
     * 判定不能（autorunスコープ外）の場合は null を返す。
     */
    private checkAutorunPermission;
    private askUserWithScope;
    /** 非TTYモード用: NonTTYReader から1行読んでテキストメニューで選択 */
    private askUserNonTTY;
    /** action 文字列から許可結果を返す（TTY/非TTY共通） */
    private resolvePermissionAction;
    private formatToolSummary;
}
//# sourceMappingURL=permission-manager.d.ts.map