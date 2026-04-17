export type ProviderType = "ollama" | "lmstudio" | "llamacpp" | "vllm";
export type CloudProviderType = "vertex-ai" | "azure-openai" | "azure-claude";
export type SecondLLMProviderType = ProviderType | CloudProviderType;
export interface SamplingParams {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
}
export interface LLMEndpoint extends SamplingParams {
    providerType: ProviderType;
    baseUrl: string;
    model: string;
    contextWindow?: number;
}
export interface SecondLLMEndpoint {
    providerType: SecondLLMProviderType;
    model: string;
    contextWindow?: number;
    baseUrl?: string;
    projectId?: string;
    region?: string;
    endpoint?: string;
    apiKey?: string;
    deploymentName?: string;
}
export interface BudgetConfig {
    limitUsd: number;
    warningThreshold: number;
    stopThreshold: number;
}
export interface CostConfig {
    referenceModels: string[];
}
export interface SecondLLMConfig {
    enabled: boolean;
    endpoint: SecondLLMEndpoint;
    budget: BudgetConfig | null;
    cost: CostConfig;
}
export interface SecurityRuleConfig {
    /** 自動許可するパターンルール例: "bash(npm *)", "file_write(./src/**)" */
    allow: string[];
    /** 常に拒否するパターンルール例: "bash(rm -rf *)" */
    deny: string[];
    /** 常に確認するパターンルール例: "bash(git push *)" */
    ask: string[];
}
export interface ProcessSandboxConfig {
    /** OS-level サンドボックスを有効にするか（デフォルト: false） */
    enabled: boolean;
    /**
     * サンドボックスレベル:
     * - "none"    : OS-level 隔離なし（アプリレベルのみ）
     * - "network" : ネットワーク名前空間隔離（Linux: unshare --net, macOS: sandbox-exec で network deny）
     * - "full"    : ネットワーク + ファイルシステム隔離（Linux: bwrap, macOS: sandbox-exec）
     */
    level: "none" | "network" | "full";
}
export interface SecurityConfig {
    allowedDirectories: string[];
    blockedCommands: string[];
    autoApproveTools: string[];
    requireApprovalTools: string[];
    /** Discord経由のリクエストで自動許可するツール（インタラクティブ確認なし） */
    discordAutoApproveTools: string[];
    /** Slack経由のリクエストで自動許可するツール（インタラクティブ確認なし） */
    slackAutoApproveTools: string[];
    /** Claude Code 互換のパターンベース権限ルール（ツール名リストより優先） */
    rules?: SecurityRuleConfig;
    streamCommandOutput?: boolean;
    /** OS-level プロセスサンドボックス設定（bash ツール実行に適用） */
    processSandbox?: ProcessSandboxConfig;
}
export interface ContextConfig {
    compressionThreshold: number;
    maxHistoryMessages: number;
}
export interface DiscordConfig {
    enabled: boolean;
    webhookUrl: string;
    applicationId?: string;
    publicKey?: string;
    botToken?: string;
    interactionPort?: number;
    listenEnabled?: boolean;
}
export interface SlackConfig {
    enabled: boolean;
    webhookUrl: string;
    botToken?: string;
    appToken?: string;
}
export interface SearchConfig {
    /** 検索プロバイダー: "duckduckgo" (デフォルト) | "searxng" */
    provider: "duckduckgo" | "searxng";
    /** SearXNG の JSON API エンドポイント (例: "http://localhost:8888") */
    searxngUrl?: string;
}
export interface ObsidianConfig {
    /** Obsidian Vault の絶対パス */
    vaultPath: string;
    /** ナレッジノートの保存先ディレクトリ (vault相対、デフォルト: "Knowledge") */
    knowledgeDir?: string;
    /** 全ノートに自動付与するタグ (デフォルト: ["lllmagents"]) */
    defaultTags?: string[];
}
export interface ChatLogConfig {
    /** チャットログ保存の有効/無効 */
    enabled: boolean;
    /** 保存先 Obsidian Vault の絶対パス（ナレッジ用vaultとは別指定可） */
    vaultPath: string;
}
export interface Config {
    mainLLM: LLMEndpoint;
    visionLLM: LLMEndpoint | null;
    secondLLM: SecondLLMConfig | null;
    security: SecurityConfig;
    context: ContextConfig;
    discord?: DiscordConfig;
    slack?: SlackConfig;
    /** Web検索設定 */
    search?: SearchConfig;
    /** Obsidian Vault 連携 (ナレッジベース) */
    obsidian?: ObsidianConfig;
    /** true: テキストをリアルタイムにストリーミング表示。false(デフォルト): スピナー+完了後Markdownレンダリング */
    streamingDisplay?: boolean;
    /** ツールの最大並列実行数（デフォルト: 3）。vLLM KVキャッシュやリソースに合わせて調整 */
    maxParallelTools?: number;
    /** 自律実行モード（再起動後も維持） */
    autorunMode?: boolean;
    /** チャットログ保存設定（Obsidian Vault に会話ログを蓄積） */
    chatLog?: ChatLogConfig;
}
export declare function isCloudProvider(type: SecondLLMProviderType): boolean;
export interface ModelInfo {
    name: string;
    size: number;
    contextLength: number;
    supportsVision: boolean;
    supportsFunctionCalling: boolean;
    digest?: string;
    family?: string;
}
export interface ModelDetail extends ModelInfo {
    parameterSize?: string;
    quantizationLevel?: string;
    format?: string;
}
/**
 * 人間可読なトークン数表記をパースする。
 * "128k" → 128000, "256K" → 256000, "1m" → 1000000, "4096" → 4096
 * パース不能なら NaN を返す。
 */
export declare function parseTokenCount(input: string): number;
export declare const DEFAULT_PORTS: Record<ProviderType, number>;
export declare const PROVIDER_LABELS: Record<ProviderType, string>;
export declare function getDefaultConfig(): Config;
//# sourceMappingURL=types.d.ts.map