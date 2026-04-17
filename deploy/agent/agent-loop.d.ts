import type { LLMProvider, ContentPart } from "../providers/base-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { PermissionManager, RequestSource } from "../security/permission-manager.js";
import type { HookManager } from "../hooks/hook-manager.js";
import { MessageHistory } from "./message-history.js";
import { type SkillInfo } from "./system-prompt.js";
import { type SessionData } from "./session-manager.js";
import { PlanManager } from "./plan-mode.js";
import type { SamplingParams } from "../config/types.js";
import type { SecondLLMManager } from "../second-llm/second-llm-manager.js";
import type { ChatLogger } from "./chat-logger.js";
export declare class AgentLoop {
    private provider;
    private model;
    private toolRegistry;
    private permissions;
    private history;
    private contextManager;
    private toolExecutor;
    private session;
    private planManager;
    /** Discord Interaction Server などから並行処理を避けるためのフラグ */
    isProcessing: boolean;
    /** true: テキストをリアルタイムにストリーミング表示。false: スピナー+完了後Markdownレンダリング */
    private streamingDisplay;
    /** 現在処理中のリクエストの発生元 */
    private currentSource;
    /** Ctrl+C などによる中断フラグ */
    private _aborted;
    /** file_edit 連続失敗カウンタ（ファイルパス → 連続失敗回数） */
    private fileEditFailCounts;
    /** ツールの最大並列実行数 */
    private maxParallelTools;
    /** モデルのコンテキストウィンドウサイズ（トークン数） — max_tokens算出に使用 */
    private contextWindow;
    /** サンプリングパラメータ（未指定ならサーバー側デフォルトに委ねる） */
    private samplingParams;
    /** LLM I/O ロガー */
    private llmLogger;
    /** 意図分類器（ヒューリスティック + LLM併用） */
    private intentClassifier;
    /** 直前ターンのプロンプトトークン数（待機スピナーでの文脈サイズ表示用） */
    private lastPromptTokens;
    /** チャットログ（Obsidian Vault保存、null なら無効） */
    private chatLogger;
    /** Evaluator（成果物の独立レビュー） */
    private evaluator;
    constructor(provider: LLMProvider, model: string, toolRegistry: ToolRegistry, permissions: PermissionManager, contextWindow: number, compressionThreshold: number, hookManager?: HookManager, skills?: SkillInfo[], agentId?: string, sessionId?: string, streamingDisplay?: boolean, maxParallelTools?: number, hasSecondLLM?: boolean, samplingParams?: SamplingParams, hasObsidian?: boolean, secondLLMManager?: SecondLLMManager | null);
    setPlanManager(pm: PlanManager): void;
    getChatLogger(): ChatLogger | null;
    setChatLogger(cl: ChatLogger | null): void;
    /** 実行中の処理を中断する（Ctrl+C など）。次のイテレーション冒頭で停止する */
    abort(): void;
    /** 中断フラグをリセットする（次の run() 開始前に呼ぶ） */
    clearAbort(): void;
    isAborted(): boolean;
    run(userMessage: string | ContentPart[], options?: {
        source?: RequestSource;
    }): Promise<void>;
    /** Get tool definitions, filtered by plan mode or Discord source */
    private getFilteredToolDefs;
    /** Execute a single tool call, returning whether to abort the rest of the run loop */
    private executeSingleTool;
    /** Execute multiple tool calls with concurrency limit, returning whether to abort the run loop */
    private executeToolsParallel;
    /** ツール実行結果のユーザー向けカラーdiff表示 */
    private renderUserDisplay;
    forceCompress(): Promise<void>;
    saveCurrentSession(): void;
    restoreSession(sessionData: SessionData): void;
    getHistory(): MessageHistory;
    getProvider(): LLMProvider;
    getModel(): string;
    getContextWindow(): number;
    setContextWindow(value: number): void;
    setModel(model: string): void;
    getStreamingDisplay(): boolean;
    setStreamingDisplay(value: boolean): void;
    getToolRegistry(): ToolRegistry;
    getPermissions(): PermissionManager;
    getMaxParallelTools(): number;
    setMaxParallelTools(value: number): void;
}
//# sourceMappingURL=agent-loop.d.ts.map