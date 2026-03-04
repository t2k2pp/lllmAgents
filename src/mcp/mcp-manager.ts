/**
 * MCP Manager - MCPサーバーのライフサイクル管理とツール統合
 *
 * 責務:
 * - MCP設定ファイルの読み込み (.localllm/mcp-servers.json, ~/.localllm/mcp-servers.json)
 * - MCPサーバーの起動・接続・切断
 * - MCPツール → ToolHandler 変換 → ToolRegistry 登録
 * - セッション終了時のクリーンアップ
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import chalk from "chalk";
import { MCPClient } from "./mcp-client.js";
import type { MCPServerConfig, MCPServersConfig, MCPTool, MCPContentBlock } from "./types.js";
import type { ToolHandler, ToolResult, ToolRegistry } from "../tools/tool-registry.js";
import type { ToolDefinition } from "../providers/base-provider.js";

/** MCPツール名にサーバープレフィックスを付与する形式 */
function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private configPaths: string[];

  constructor(projectDir: string = process.cwd()) {
    // 設定ファイルの検索パス（後が優先）
    this.configPaths = [
      path.join(os.homedir(), ".localllm", "mcp-servers.json"),
      path.join(projectDir, ".localllm", "mcp-servers.json"),
      path.join(projectDir, ".claude", "mcp-servers.json"),
    ];
  }

  /**
   * 設定ファイルからMCPサーバー定義を読み込む
   */
  loadConfig(): Record<string, MCPServerConfig> {
    const merged: Record<string, MCPServerConfig> = {};

    for (const configPath of this.configPaths) {
      if (!fs.existsSync(configPath)) continue;

      try {
        const content = fs.readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(content) as MCPServersConfig;

        if (parsed.mcpServers) {
          for (const [key, serverConfig] of Object.entries(parsed.mcpServers)) {
            merged[key] = {
              ...serverConfig,
              name: serverConfig.name ?? key,
            };
          }
        }
      } catch (err) {
        console.error(chalk.yellow(`  Warning: MCP設定ファイル読み込みエラー: ${configPath}`));
      }
    }

    return merged;
  }

  /**
   * すべてのMCPサーバーに接続し、ツールをToolRegistryに登録する
   */
  async connectAll(registry: ToolRegistry): Promise<number> {
    const configs = this.loadConfig();
    let totalTools = 0;

    for (const [key, config] of Object.entries(configs)) {
      try {
        const client = new MCPClient(config);
        await client.connect();
        this.clients.set(key, client);

        // ツールをToolHandlerに変換して登録
        const handlers = this.createToolHandlers(client);
        for (const handler of handlers) {
          registry.register(handler);
        }

        totalTools += handlers.length;
        console.log(
          chalk.green(`  ✓ MCP: ${config.name} (${handlers.length} tools)`)
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          chalk.yellow(`  ⚠ MCP: ${config.name} 接続失敗: ${errMsg}`)
        );
      }
    }

    return totalTools;
  }

  /**
   * MCPクライアントのツールをToolHandlerに変換する
   */
  private createToolHandlers(client: MCPClient): ToolHandler[] {
    return client.tools.map((mcpTool) => this.mcpToolToHandler(client, mcpTool));
  }

  /**
   * 単一のMCPツール → ToolHandler変換
   */
  private mcpToolToHandler(client: MCPClient, mcpTool: MCPTool): ToolHandler {
    const toolName = mcpToolName(client.name, mcpTool.name);

    const definition: ToolDefinition = {
      type: "function",
      function: {
        name: toolName,
        description: mcpTool.description ?? `MCP tool: ${mcpTool.name} (${client.name})`,
        parameters: mcpTool.inputSchema ?? { type: "object", properties: {} },
      },
    };

    return {
      name: toolName,
      definition,
      async execute(params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const result = await client.callTool({
            name: mcpTool.name, // MCPサーバーにはオリジナル名で送る
            arguments: params,
          });

          if (result.isError) {
            const errorText = extractText(result.content);
            return {
              success: false,
              output: "",
              error: errorText || "MCP tool execution failed",
            };
          }

          const output = extractText(result.content);
          return { success: true, output };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return { success: false, output: "", error: errMsg };
        }
      },
    };
  }

  /**
   * 接続中のMCPサーバー一覧を取得
   */
  getConnectedServers(): Array<{ name: string; toolCount: number }> {
    const servers: Array<{ name: string; toolCount: number }> = [];
    for (const [, client] of this.clients) {
      if (client.connected) {
        servers.push({
          name: client.name,
          toolCount: client.tools.length,
        });
      }
    }
    return servers;
  }

  /**
   * 全MCPサーバーを切断する
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];
    for (const [, client] of this.clients) {
      disconnectPromises.push(client.disconnect().catch(() => {}));
    }
    await Promise.all(disconnectPromises);
    this.clients.clear();
  }
}

/**
 * MCPレスポンスのContentBlocksからテキストを抽出する
 */
function extractText(content: MCPContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}
