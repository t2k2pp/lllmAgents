import type { SecondLLMConfig, SecondLLMEndpoint } from "../config/types.js";
import type { LLMProvider } from "../providers/base-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { PermissionManager } from "../security/permission-manager.js";
export declare class SecondLLMManager {
    private toolRegistry;
    private permissions;
    private provider;
    private config;
    private endpoint;
    private delegationGuard;
    private sessionId?;
    constructor(toolRegistry: ToolRegistry, permissions: PermissionManager);
    /** メインのセッションIDを設定（ログファイル名の共有用） */
    setSessionId(sessionId: string): void;
    /** agentId付きのLLMLoggerを生成 */
    private createLogger;
    initialize(config: SecondLLMConfig, passphrase?: string): void;
    isAvailable(): boolean;
    onUserTurn(): void;
    getConfig(): SecondLLMConfig | null;
    getEndpoint(): SecondLLMEndpoint | null;
    getProvider(): LLMProvider | null;
    protected checkDelegation(): void;
    consult(prompt: string): Promise<string>;
    runAsAgent(prompt: string): Promise<string>;
    /**
     * Evaluator用エージェント実行。
     * 読み取り専用ツール（file_read, grep, glob）のみ使用可能。
     * ファイルパス一覧を渡し、Evaluator自身が必要な箇所を読んで評価する。
     */
    runAsEvaluator(params: {
        systemPrompt: string;
        userPrompt: string;
        maxIterations?: number;
    }): Promise<string>;
}
//# sourceMappingURL=second-llm-manager.d.ts.map