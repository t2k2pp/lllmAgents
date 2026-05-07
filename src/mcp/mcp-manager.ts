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
  /**
   * Phase F-1b: 全体 ON/OFF。 false なら設定が残っていても connectAll が何もしない。
   * 起動時の --no-mcp フラグや config.json mcpEnabled=false で false 化、
   * REPL /mcp on /off で切替可能。
   */
  private globalEnabled = true;
  /**
   * Phase F-1b: 個別サーバーの runtime skip。 設定ファイルの disabled フラグと
   * 合算され、 「いずれかが true」 なら接続しない。 /mcp toggle <name> で動的切替。
   */
  private runtimeDisabledServers = new Set<string>();
  /** Phase F-1a: reload 用に直近接続時の registry を保持 */
  private lastRegistry: ToolRegistry | null = null;

  constructor(projectDir: string = process.cwd()) {
    // 設定ファイルの検索パス（後が優先）
    this.configPaths = [
      path.join(os.homedir(), ".localllm", "mcp-servers.json"),
      path.join(projectDir, ".localllm", "mcp-servers.json"),
      path.join(projectDir, ".claude", "mcp-servers.json"),
    ];
  }

  // === Phase F-1b: ON/OFF / skip 操作 API ===
  setGlobalEnabled(enabled: boolean): void {
    this.globalEnabled = enabled;
  }
  isGlobalEnabled(): boolean {
    return this.globalEnabled;
  }
  /** 個別サーバを runtime skip (設定はそのまま残す) */
  disableServer(name: string): void {
    this.runtimeDisabledServers.add(name);
  }
  enableServer(name: string): void {
    this.runtimeDisabledServers.delete(name);
  }
  /** runtime + 設定ファイル の combined 状態を返す */
  getServerStatus(): Array<{ name: string; configured: boolean; configDisabled: boolean; runtimeDisabled: boolean; connected: boolean; toolCount: number }> {
    const configs = this.loadConfig();
    const out: Array<{ name: string; configured: boolean; configDisabled: boolean; runtimeDisabled: boolean; connected: boolean; toolCount: number }> = [];
    for (const [key, c] of Object.entries(configs)) {
      const client = this.clients.get(key);
      out.push({
        name: c.name ?? key,
        configured: true,
        configDisabled: c.disabled === true,
        runtimeDisabled: this.runtimeDisabledServers.has(c.name ?? key),
        connected: client?.connected === true,
        toolCount: client?.tools.length ?? 0,
      });
    }
    return out;
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
   *
   * Phase F-1b: 接続スキップ条件 (= 設定はあっても接続しない)
   *   - this.globalEnabled === false  (= /mcp off / --no-mcp 等)
   *   - config.disabled === true       (= mcp-servers.json で個別無効化)
   *   - runtimeDisabledServers に含む  (= REPL で /mcp toggle <name> で動的に外した)
   */
  async connectAll(registry: ToolRegistry): Promise<number> {
    this.lastRegistry = registry;
    if (!this.globalEnabled) {
      console.log(chalk.dim("  MCP: globally disabled (skipping all servers)"));
      return 0;
    }
    const configs = this.loadConfig();
    let totalTools = 0;
    let skipped = 0;

    for (const [key, config] of Object.entries(configs)) {
      const serverName = config.name ?? key;
      if (config.disabled === true || this.runtimeDisabledServers.has(serverName)) {
        const reason = config.disabled === true ? "config.disabled" : "runtime skip";
        console.log(chalk.dim(`  ○ MCP: ${serverName} skipped (${reason})`));
        skipped++;
        continue;
      }
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
          chalk.green(`  ✓ MCP: ${serverName} (${handlers.length} tools)`)
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          chalk.yellow(`  ⚠ MCP: ${serverName} 接続失敗: ${errMsg}`)
        );
      }
    }

    if (skipped > 0) {
      console.log(chalk.dim(`  MCP: ${skipped} server(s) skipped by configuration`));
    }
    return totalTools;
  }

  /**
   * Phase F-1a: 全 MCP サーバーを切断 → 再接続。
   * 設定ファイル変更後・サーバー側の再起動後等に使う。
   * @returns 再接続後のツール総数
   */
  async reload(registry?: ToolRegistry): Promise<number> {
    const target = registry ?? this.lastRegistry;
    if (!target) {
      throw new Error("MCPManager.reload: no registry available (not connected before)");
    }
    await this.disconnectAll();
    return this.connectAll(target);
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
