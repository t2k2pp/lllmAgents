/**
 * MCP (Model Context Protocol) 型定義
 *
 * JSON-RPC 2.0 ベースのプロトコルで、外部ツールサーバーと通信する。
 * 参照: https://modelcontextprotocol.io/specification
 */

// --- JSON-RPC 2.0 ---

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// --- MCP Server Configuration ---

export type MCPTransport = "stdio" | "sse";

/** mcp-servers.json の permissionLevel に書ける値 */
export type MCPServerPermissionLevel = "ask" | "auto" | "autorun";
/** mcp-servers.json の tools.<ツール名> に書ける値 */
export type MCPToolPermissionLevel = MCPServerPermissionLevel | "inspect";

export interface MCPServerConfig {
  /** サーバー名（ツール名のプレフィックスに使用） */
  name: string;
  /** トランスポート種別 */
  transport: MCPTransport;
  /** stdio: 実行コマンド */
  command?: string;
  /** stdio: コマンド引数 */
  args?: string[];
  /** stdio: 環境変数 */
  env?: Record<string, string>;
  /** sse: サーバーURL */
  url?: string;
  /**
   * サーバーが提供するツールの権限の既定 (docs/mcp-tool-permission-design.md)。
   * - "ask": 毎回確認 (従来どおり)
   * - "auto": 常に自動許可 (destructiveHint のツールは除く)
   * - "autorun": 自律実行モード (autorun) の間だけ自動許可 (destructiveHint のツールは除く)
   * 未指定ならツールの注釈 (readOnlyHint) で判定し、 それ以外は確認。
   */
  permissionLevel?: MCPServerPermissionLevel;
  /**
   * ツールごとの上書き (キーはサーバー側のツール名。 例 "execute_blender_code")。
   * "inspect" は登録された中身の検査器で判定する (検査器が無ければ確認)。
   */
  tools?: Record<string, MCPToolPermissionLevel>;
  /**
   * Phase F-1b: このサーバーを **設定ファイルに残したまま** 接続スキップする。
   * デフォルト false (= 接続する)。 true なら mcp-servers.json から削除せず一時無効化できる。
   * REPL の /mcp toggle <server> で動的に切替可能。
   */
  disabled?: boolean;
}

export interface MCPServersConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

// --- MCP Protocol Messages ---

export interface MCPInitializeParams {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
  };
  serverInfo: {
    name: string;
    version?: string;
  };
}

/** MCP 標準のツール注釈 (tools/list の annotations)。 どれも「ヒント」でありサーバーの自己申告 */
export interface MCPToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface MCPTool {
  name: string;
  description?: string;
  annotations?: MCPToolAnnotations;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface MCPToolsListResult {
  tools: MCPTool[];
  nextCursor?: string;
}

export interface MCPToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface MCPToolCallResult {
  content: MCPContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface MCPContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri: string; text?: string; mimeType?: string };
}
