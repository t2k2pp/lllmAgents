/**
 * MCP Manager - MCPサーバーのライフサイクル管理とツール統合
 *
 * 責務:
 * - MCP設定ファイルの読み込み (.localllm/mcp-servers.json, ~/.localllm/mcp-servers.json)
 * - MCPサーバーの起動・接続・切断
 * - MCPツール → ToolHandler 変換 → ToolRegistry 登録
 * - セッション終了時のクリーンアップ
 */
import type { MCPServerConfig } from "./types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
export declare class MCPManager {
    private clients;
    private configPaths;
    constructor(projectDir?: string);
    /**
     * 設定ファイルからMCPサーバー定義を読み込む
     */
    loadConfig(): Record<string, MCPServerConfig>;
    /**
     * すべてのMCPサーバーに接続し、ツールをToolRegistryに登録する
     */
    connectAll(registry: ToolRegistry): Promise<number>;
    /**
     * MCPクライアントのツールをToolHandlerに変換する
     */
    private createToolHandlers;
    /**
     * 単一のMCPツール → ToolHandler変換
     */
    private mcpToolToHandler;
    /**
     * 接続中のMCPサーバー一覧を取得
     */
    getConnectedServers(): Array<{
        name: string;
        toolCount: number;
    }>;
    /**
     * 全MCPサーバーを切断する
     */
    disconnectAll(): Promise<void>;
}
//# sourceMappingURL=mcp-manager.d.ts.map