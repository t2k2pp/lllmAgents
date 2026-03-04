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
  /** サーバーが提供するツールに対するパーミッション ("auto" | "ask") */
  permissionLevel?: "auto" | "ask";
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

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface MCPToolsListResult {
  tools: MCPTool[];
}

export interface MCPToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface MCPToolCallResult {
  content: MCPContentBlock[];
  isError?: boolean;
}

export interface MCPContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}
