export interface LLMRequestLog {
    ts: string;
    turn: number;
    agentId: string;
    type: "request";
    model: string;
    messages: unknown[];
    tools?: unknown[];
}
export interface LLMResponseLog {
    ts: string;
    turn: number;
    agentId: string;
    type: "response";
    model: string;
    thinking?: string;
    text?: string;
    toolCalls?: unknown[];
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
}
export type LLMLogEntry = LLMRequestLog | LLMResponseLog;
export declare class LLMLogger {
    private readonly agentId;
    private readonly filePath;
    private turn;
    private requestStartMs;
    constructor(agentId?: string, sessionId?: string);
    /** ターン番号をインクリメント（LLM呼び出し前に呼ぶ） */
    nextTurn(): void;
    /** LLM リクエストをログに記録 */
    logRequest(messages: unknown[], model: string, tools?: unknown[]): void;
    /** LLM レスポンスをログに記録（thinking content 含む） */
    logResponse(data: {
        model: string;
        thinking?: string;
        text?: string;
        toolCalls?: unknown[];
        tokensIn?: number;
        tokensOut?: number;
        finishReason?: string;
    }): void;
    getFilePath(): string;
    getAgentId(): string;
    private write;
}
/**
 * セッション ID を生成する。
 * AgentLoop インスタンス生成時に一度だけ呼び出し、
 * メインと全サブエージェントで共有することでログファイル名を揃える。
 */
export declare function createSessionId(): string;
//# sourceMappingURL=llm-logger.d.ts.map