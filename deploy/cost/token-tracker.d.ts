export interface TokenUsageRecord {
    timestamp: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    estimatedCostUsd: number;
    sessionId?: string;
}
export interface SessionTotal {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    recordCount: number;
}
export declare class TokenTracker {
    private sessionRecords;
    /** API呼び出し後にトークン使用量を記録 */
    record(usage: TokenUsageRecord): void;
    /** セッション全体のトークン合計・コスト合計を取得 */
    getSessionTotal(): SessionTotal;
    /** セッション内の全レコードを取得 */
    getRecords(): readonly TokenUsageRecord[];
    /** 月次ログファイルに永続化 */
    flush(): void;
}
export declare const globalTokenTracker: TokenTracker;
//# sourceMappingURL=token-tracker.d.ts.map