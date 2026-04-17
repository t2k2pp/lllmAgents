/**
 * MCP Client - JSON-RPC 2.0 over stdio/SSE
 *
 * 外部MCPサーバーとの通信を管理する。
 * - stdio: 子プロセスのstdin/stdoutでJSON-RPCメッセージを送受信
 * - sse: HTTP SSE接続でイベントを受信、POSTでリクエスト送信
 */
import { spawn } from "node:child_process";
const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_NAME = "localllm-agent";
const CLIENT_VERSION = "0.1.0";
/** MCPツール呼び出しのタイムアウト。外部ツールも時間がかかりうるため余裕を持たせる */
const REQUEST_TIMEOUT_MS = 300_000; // 5分
export class MCPClient {
    config;
    process = null;
    requestId = 0;
    pendingRequests = new Map();
    buffer = "";
    _serverInfo = null;
    _tools = [];
    _connected = false;
    // SSE用
    sseAbortController = null;
    sseEndpoint = null;
    constructor(config) {
        this.config = config;
    }
    get name() {
        return this.config.name;
    }
    get connected() {
        return this._connected;
    }
    get tools() {
        return this._tools;
    }
    get serverInfo() {
        return this._serverInfo;
    }
    /**
     * MCPサーバーに接続し、初期化・ツール一覧取得を行う
     */
    async connect() {
        if (this.config.transport === "stdio") {
            await this.connectStdio();
        }
        else if (this.config.transport === "sse") {
            await this.connectSSE();
        }
        else {
            throw new Error(`Unsupported transport: ${this.config.transport}`);
        }
        // Initialize
        const initResult = await this.sendRequest("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
                tools: {},
            },
            clientInfo: {
                name: CLIENT_NAME,
                version: CLIENT_VERSION,
            },
        });
        this._serverInfo = initResult;
        // Send initialized notification
        this.sendNotification("notifications/initialized", {});
        // Get tools
        const toolsResult = await this.sendRequest("tools/list", {});
        this._tools = toolsResult.tools ?? [];
        this._connected = true;
    }
    /**
     * MCPツールを呼び出す
     */
    async callTool(params) {
        return this.sendRequest("tools/call", { ...params });
    }
    /**
     * 接続を終了する
     */
    async disconnect() {
        this._connected = false;
        // Pending requests をすべてキャンセル
        for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Client disconnected"));
        }
        this.pendingRequests.clear();
        if (this.config.transport === "stdio" && this.process) {
            this.process.stdin?.end();
            this.process.kill("SIGTERM");
            // 猶予を与えてからSIGKILL
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.process.kill("SIGKILL");
                }
            }, 3000);
            this.process = null;
        }
        if (this.sseAbortController) {
            this.sseAbortController.abort();
            this.sseAbortController = null;
        }
    }
    // --- stdio transport ---
    async connectStdio() {
        const { command, args = [], env } = this.config;
        if (!command) {
            throw new Error(`MCP server "${this.config.name}": command is required for stdio transport`);
        }
        const mergedEnv = { ...process.env, ...env };
        this.process = spawn(command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: mergedEnv,
            shell: false,
        });
        this.process.stdout?.setEncoding("utf-8");
        this.process.stdout?.on("data", (data) => {
            this.onStdioData(data);
        });
        this.process.stderr?.on("data", (data) => {
            // MCPサーバーのstderrはデバッグログとして扱う
            const msg = data.toString().trim();
            if (msg) {
                // 静かに無視（デバッグ時はここにログを入れる）
            }
        });
        this.process.on("error", (err) => {
            this._connected = false;
            // すべての pending requests を reject
            for (const [, pending] of this.pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(new Error(`MCP server "${this.config.name}" process error: ${err.message}`));
            }
            this.pendingRequests.clear();
        });
        this.process.on("exit", (code) => {
            this._connected = false;
            for (const [, pending] of this.pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(new Error(`MCP server "${this.config.name}" exited with code ${code}`));
            }
            this.pendingRequests.clear();
        });
        // プロセスが起動するのを少し待つ
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 500);
            this.process?.on("error", (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }
    onStdioData(data) {
        this.buffer += data;
        // JSON-RPCメッセージは改行区切り (NDJSON)
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const msg = JSON.parse(trimmed);
                this.handleResponse(msg);
            }
            catch {
                // パースできない行はスキップ
            }
        }
    }
    // --- SSE transport ---
    async connectSSE() {
        const { url } = this.config;
        if (!url) {
            throw new Error(`MCP server "${this.config.name}": url is required for sse transport`);
        }
        this.sseAbortController = new AbortController();
        // SSE接続を開始してエンドポイントURLを取得
        const response = await fetch(url, {
            headers: { Accept: "text/event-stream" },
            signal: this.sseAbortController.signal,
        });
        if (!response.ok) {
            throw new Error(`MCP SSE server "${this.config.name}" returned ${response.status}`);
        }
        // SSEストリームをバックグラウンドで処理
        this.processSSEStream(response);
        // エンドポイントURLが設定されるまで待つ
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.sseEndpoint) {
                    resolve();
                }
                else {
                    reject(new Error(`MCP SSE server "${this.config.name}": endpoint not received within timeout`));
                }
            }, 5000);
            const check = setInterval(() => {
                if (this.sseEndpoint) {
                    clearInterval(check);
                    clearTimeout(timer);
                    resolve();
                }
            }, 100);
        });
    }
    async processSSEStream(response) {
        const reader = response.body?.getReader();
        if (!reader)
            return;
        const decoder = new TextDecoder();
        let sseBuffer = "";
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                sseBuffer += decoder.decode(value, { stream: true });
                const events = sseBuffer.split("\n\n");
                sseBuffer = events.pop() ?? "";
                for (const event of events) {
                    this.handleSSEEvent(event);
                }
            }
        }
        catch {
            // SSE接続が切断された
            this._connected = false;
        }
    }
    handleSSEEvent(event) {
        let eventType = "message";
        let data = "";
        for (const line of event.split("\n")) {
            if (line.startsWith("event:")) {
                eventType = line.slice(6).trim();
            }
            else if (line.startsWith("data:")) {
                data += line.slice(5).trim();
            }
        }
        if (eventType === "endpoint") {
            // MCPサーバーがPOSTエンドポイントURLを通知
            const baseUrl = new URL(this.config.url);
            this.sseEndpoint = new URL(data, baseUrl).toString();
        }
        else if (eventType === "message" && data) {
            try {
                const msg = JSON.parse(data);
                this.handleResponse(msg);
            }
            catch {
                // パースエラー
            }
        }
    }
    // --- JSON-RPC ---
    async sendRequest(method, params) {
        const id = ++this.requestId;
        const request = {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`MCP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
            }, REQUEST_TIMEOUT_MS);
            this.pendingRequests.set(id, {
                resolve: (response) => {
                    if (response.error) {
                        reject(new Error(`MCP error (${response.error.code}): ${response.error.message}`));
                    }
                    else {
                        resolve(response.result);
                    }
                },
                reject,
                timer,
            });
            this.sendMessage(request);
        });
    }
    sendNotification(method, params) {
        const notification = {
            jsonrpc: "2.0",
            method,
            params,
        };
        this.sendMessage(notification);
    }
    sendMessage(message) {
        const json = JSON.stringify(message);
        if (this.config.transport === "stdio" && this.process?.stdin) {
            this.process.stdin.write(json + "\n");
        }
        else if (this.config.transport === "sse" && this.sseEndpoint) {
            // SSE: POSTでリクエストを送信
            fetch(this.sseEndpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: json,
                signal: this.sseAbortController?.signal,
            }).catch(() => {
                // SSE POST failure
            });
        }
    }
    handleResponse(msg) {
        if (msg.id == null)
            return; // Notification, ignore
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            pending.resolve(msg);
        }
    }
}
//# sourceMappingURL=mcp-client.js.map