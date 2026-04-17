/**
 * MCP Client - JSON-RPC 2.0 over stdio/SSE
 *
 * 外部MCPサーバーとの通信を管理する。
 * - stdio: 子プロセスのstdin/stdoutでJSON-RPCメッセージを送受信
 * - sse: HTTP SSE接続でイベントを受信、POSTでリクエスト送信
 */
import type { MCPServerConfig, MCPInitializeResult, MCPToolCallParams, MCPToolCallResult, MCPTool } from "./types.js";
export declare class MCPClient {
    private config;
    private process;
    private requestId;
    private pendingRequests;
    private buffer;
    private _serverInfo;
    private _tools;
    private _connected;
    private sseAbortController;
    private sseEndpoint;
    constructor(config: MCPServerConfig);
    get name(): string;
    get connected(): boolean;
    get tools(): MCPTool[];
    get serverInfo(): MCPInitializeResult | null;
    /**
     * MCPサーバーに接続し、初期化・ツール一覧取得を行う
     */
    connect(): Promise<void>;
    /**
     * MCPツールを呼び出す
     */
    callTool(params: MCPToolCallParams): Promise<MCPToolCallResult>;
    /**
     * 接続を終了する
     */
    disconnect(): Promise<void>;
    private connectStdio;
    private onStdioData;
    private connectSSE;
    private processSSEStream;
    private handleSSEEvent;
    private sendRequest;
    private sendNotification;
    private sendMessage;
    private handleResponse;
}
//# sourceMappingURL=mcp-client.d.ts.map