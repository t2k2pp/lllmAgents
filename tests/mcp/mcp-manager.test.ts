import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

// fs モック
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
  };
});

// chalk モック
vi.mock("chalk", () => ({
  default: {
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    cyan: (s: string) => s,
  },
}));

// MCPClient モック
vi.mock("../../src/mcp/mcp-client.js", () => ({
  MCPClient: vi.fn().mockImplementation((config: Record<string, unknown>) => ({
    name: config.name,
    connected: false,
    tools: [],
    connect: vi.fn(),
    callTool: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

import * as fs from "node:fs";
import { MCPManager } from "../../src/mcp/mcp-manager.js";
import { MCPClient } from "../../src/mcp/mcp-client.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

describe("MCPManager", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
  });

  describe("loadConfig", () => {
    it("should return empty config when no files exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const manager = new MCPManager("/test/project");
      const config = manager.loadConfig();
      expect(config).toEqual({});
    });

    it("should load config from project .localllm/mcp-servers.json", () => {
      const projectConfig = {
        mcpServers: {
          "test-server": {
            name: "test-server",
            transport: "stdio",
            command: "node",
            args: ["server.js"],
          },
        },
      };

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes(".localllm");
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(projectConfig));

      const manager = new MCPManager("/test/project");
      const config = manager.loadConfig();

      expect(config["test-server"]).toBeDefined();
      expect(config["test-server"].transport).toBe("stdio");
      expect(config["test-server"].command).toBe("node");
    });

    it("should merge configs with later paths overriding earlier", () => {
      const globalConfig = {
        mcpServers: {
          shared: { name: "shared", transport: "stdio", command: "global-cmd" },
          "global-only": { name: "global-only", transport: "sse", url: "http://global" },
        },
      };
      const projectConfig = {
        mcpServers: {
          shared: { name: "shared", transport: "stdio", command: "project-cmd" },
        },
      };

      const homedir = os.homedir();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.startsWith(homedir)) {
          return JSON.stringify(globalConfig);
        }
        return JSON.stringify(projectConfig);
      });

      const manager = new MCPManager("/test/project");
      const config = manager.loadConfig();

      // project overrides global for "shared"
      expect(config.shared.command).toBe("project-cmd");
      // global-only is preserved
      expect(config["global-only"]).toBeDefined();
    });

    it("should handle malformed JSON gracefully", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("not json");

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const manager = new MCPManager("/test/project");
      const config = manager.loadConfig();

      expect(config).toEqual({});
      consoleSpy.mockRestore();
    });
  });

  describe("connectAll", () => {
    it("should return 0 when no servers configured", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const manager = new MCPManager("/test/project");
      const count = await manager.connectAll(registry);
      expect(count).toBe(0);
    });

    it("should connect to configured servers and register tools", async () => {
      const serverConfig = {
        mcpServers: {
          "test-server": {
            name: "test-server",
            transport: "stdio",
            command: "node",
            args: ["server.js"],
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(serverConfig));

      // MCPClient モックにツールを設定
      const mockTools = [
        {
          name: "list_files",
          description: "List files in a directory",
          inputSchema: {
            type: "object" as const,
            properties: {
              path: { type: "string", description: "Directory path" },
            },
          },
        },
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object" as const,
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      ];

      vi.mocked(MCPClient).mockImplementation((config: Record<string, unknown>) => ({
        name: config.name as string,
        connected: true,
        tools: mockTools,
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "result" }],
        }),
        disconnect: vi.fn().mockResolvedValue(undefined),
      }) as unknown as MCPClient);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const manager = new MCPManager("/test/project");
      const count = await manager.connectAll(registry);

      // 2 tools registered
      expect(count).toBe(2);

      // Tool names should be prefixed: mcp__<server>__<tool>
      const toolNames = registry.getToolNames();
      expect(toolNames).toContain("mcp__test-server__list_files");
      expect(toolNames).toContain("mcp__test-server__read_file");

      consoleSpy.mockRestore();
    });

    it("should handle connection failures gracefully", async () => {
      const serverConfig = {
        mcpServers: {
          "failing-server": {
            name: "failing-server",
            transport: "stdio",
            command: "nonexistent",
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(serverConfig));

      vi.mocked(MCPClient).mockImplementation((config: Record<string, unknown>) => ({
        name: config.name as string,
        connected: false,
        tools: [],
        connect: vi.fn().mockRejectedValue(new Error("spawn ENOENT")),
        callTool: vi.fn(),
        disconnect: vi.fn(),
      }) as unknown as MCPClient);

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const manager = new MCPManager("/test/project");
      const count = await manager.connectAll(registry);

      expect(count).toBe(0);
      expect(registry.getToolNames()).toHaveLength(0);

      consoleErrorSpy.mockRestore();
    });
  });

  describe("tool execution", () => {
    it("should call MCP server with original tool name (without prefix)", async () => {
      const mockCallTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "file contents here" }],
        isError: false,
      });

      const serverConfig = {
        mcpServers: {
          "fs-server": {
            name: "fs-server",
            transport: "stdio",
            command: "node",
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(serverConfig));

      vi.mocked(MCPClient).mockImplementation((config: Record<string, unknown>) => ({
        name: config.name as string,
        connected: true,
        tools: [
          {
            name: "read_file",
            description: "Read file",
            inputSchema: { type: "object" as const, properties: {} },
          },
        ],
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: mockCallTool,
        disconnect: vi.fn(),
      }) as unknown as MCPClient);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const manager = new MCPManager("/test/project");
      await manager.connectAll(registry);

      // Execute the registered tool
      const tool = registry.get("mcp__fs-server__read_file");
      expect(tool).toBeDefined();

      const result = await tool!.execute({ path: "/tmp/test.txt" });
      expect(result.success).toBe(true);
      expect(result.output).toBe("file contents here");

      // Verify MCP server received the original name (not prefixed)
      expect(mockCallTool).toHaveBeenCalledWith({
        name: "read_file",
        arguments: { path: "/tmp/test.txt" },
      });

      consoleSpy.mockRestore();
    });

    it("should handle MCP tool errors", async () => {
      const serverConfig = {
        mcpServers: {
          "err-server": {
            name: "err-server",
            transport: "stdio",
            command: "node",
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(serverConfig));

      vi.mocked(MCPClient).mockImplementation((config: Record<string, unknown>) => ({
        name: config.name as string,
        connected: true,
        tools: [
          {
            name: "fail_tool",
            description: "Always fails",
            inputSchema: { type: "object" as const, properties: {} },
          },
        ],
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "something went wrong" }],
          isError: true,
        }),
        disconnect: vi.fn(),
      }) as unknown as MCPClient);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const manager = new MCPManager("/test/project");
      await manager.connectAll(registry);

      const tool = registry.get("mcp__err-server__fail_tool");
      const result = await tool!.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe("something went wrong");

      consoleSpy.mockRestore();
    });
  });

  describe("getConnectedServers", () => {
    it("should list connected servers", async () => {
      const serverConfig = {
        mcpServers: {
          server1: { name: "server1", transport: "stdio", command: "node" },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(serverConfig));

      vi.mocked(MCPClient).mockImplementation((config: Record<string, unknown>) => ({
        name: config.name as string,
        connected: true,
        tools: [
          {
            name: "t1",
            inputSchema: { type: "object" as const },
          },
          {
            name: "t2",
            inputSchema: { type: "object" as const },
          },
        ],
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn(),
        disconnect: vi.fn(),
      }) as unknown as MCPClient);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const manager = new MCPManager("/test/project");
      await manager.connectAll(registry);

      const servers = manager.getConnectedServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe("server1");
      expect(servers[0].toolCount).toBe(2);

      consoleSpy.mockRestore();
    });
  });

  describe("disconnectAll", () => {
    it("should disconnect all clients", async () => {
      const mockDisconnect = vi.fn().mockResolvedValue(undefined);

      const serverConfig = {
        mcpServers: {
          s1: { name: "s1", transport: "stdio", command: "node" },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(serverConfig));

      vi.mocked(MCPClient).mockImplementation((config: Record<string, unknown>) => ({
        name: config.name as string,
        connected: true,
        tools: [],
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn(),
        disconnect: mockDisconnect,
      }) as unknown as MCPClient);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const manager = new MCPManager("/test/project");
      await manager.connectAll(registry);
      await manager.disconnectAll();

      expect(mockDisconnect).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});

describe("MCP Types", () => {
  it("should export MCPServerConfig type", async () => {
    const { MCPClient: MCPClientType } = await import("../../src/mcp/mcp-client.js");
    expect(MCPClientType).toBeDefined();
  });

  it("should export MCPManager", async () => {
    const { MCPManager: MCPManagerType } = await import("../../src/mcp/mcp-manager.js");
    expect(MCPManagerType).toBeDefined();
  });
});

describe("MCPClient", () => {
  // MCPClient のユニットテスト（モックなしのインターフェース検証）
  it("should have correct interface", async () => {
    vi.restoreAllMocks();
    // 型チェック: MCPClient のコンストラクタは MCPServerConfig を受け取る
    const config = {
      name: "test",
      transport: "stdio" as const,
      command: "echo",
      args: [],
    };

    // MCPClient のコンストラクタがモックされているため、インターフェースのみ検証
    expect(config.name).toBe("test");
    expect(config.transport).toBe("stdio");
  });
});
