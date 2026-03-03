import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import type { ToolRegistry, ToolHandler, ToolResult } from "../../src/tools/tool-registry.js";
import type { PermissionManager } from "../../src/security/permission-manager.js";
import type { HookManager, PreHookResult } from "../../src/hooks/hook-manager.js";
import type { ToolCall } from "../../src/providers/base-provider.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock chalk to avoid color code issues in test output
vi.mock("chalk", () => ({
  default: {
    red: (s: string) => s,
    blue: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    gray: (s: string) => s,
    green: (s: string) => s,
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockToolHandler(
  name: string,
  executeFn?: (params: Record<string, unknown>) => Promise<ToolResult>,
): ToolHandler {
  return {
    name,
    definition: {
      type: "function",
      function: {
        name,
        description: `Mock tool: ${name}`,
        parameters: {},
      },
    },
    execute: executeFn ?? vi.fn(async () => ({ success: true, output: "ok" })),
  };
}

function createMockRegistry(handlers: Map<string, ToolHandler>): ToolRegistry {
  return {
    get: vi.fn((name: string) => handlers.get(name)),
    register: vi.fn(),
    getDefinitions: vi.fn(() => []),
    getToolNames: vi.fn(() => Array.from(handlers.keys())),
  } as unknown as ToolRegistry;
}

function createMockPermissions(
  overrides: Partial<{
    checkToolPermission: (
      toolName: string,
      params: Record<string, unknown>,
    ) => Promise<{ allowed: boolean; reason?: string }>;
  }> = {},
): PermissionManager {
  return {
    checkToolPermission:
      overrides.checkToolPermission ??
      vi.fn(async () => ({ allowed: true })),
    getPermissionLevel: vi.fn(() => "auto"),
    isPathAllowed: vi.fn(() => true),
  } as unknown as PermissionManager;
}

function createMockHookManager(
  overrides: Partial<{
    runPreToolHooks: (
      toolName: string,
      params: Record<string, unknown>,
    ) => Promise<PreHookResult>;
    runPostToolHooks: (
      toolName: string,
      params: Record<string, unknown>,
      result: ToolResult,
    ) => Promise<void>;
  }> = {},
): HookManager {
  return {
    runPreToolHooks:
      overrides.runPreToolHooks ??
      vi.fn(async () => ({ proceed: true })),
    runPostToolHooks:
      overrides.runPostToolHooks ?? vi.fn(async () => {}),
    loadHooks: vi.fn(),
    runSessionHooks: vi.fn(),
    count: 0,
    isLoaded: true,
  } as unknown as HookManager;
}

function createToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${name}_${Date.now()}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolExecutor", () => {
  // -----------------------------------------------------------------------
  // Basic execution
  // -----------------------------------------------------------------------

  describe("basic execution", () => {
    it("should execute a known tool and return result", async () => {
      const handler = createMockToolHandler("file_read", async () => ({
        success: true,
        output: "file contents here",
      }));

      const handlers = new Map([["file_read", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const executor = new ToolExecutor(registry, permissions);

      const result = await executor.execute(
        createToolCall("file_read", { file_path: "/tmp/test.ts" }),
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe("file contents here");
    });

    it("should pass parsed parameters to tool handler", async () => {
      const executeFn = vi.fn(async () => ({ success: true, output: "done" }));
      const handler = createMockToolHandler("bash", executeFn);

      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const executor = new ToolExecutor(registry, permissions);

      await executor.execute(createToolCall("bash", { command: "ls -la" }));

      expect(executeFn).toHaveBeenCalledWith({ command: "ls -la" });
    });

    it("should handle tool execution errors gracefully", async () => {
      const handler = createMockToolHandler("bash", async () => {
        throw new Error("Process exited with code 1");
      });

      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const executor = new ToolExecutor(registry, permissions);

      const result = await executor.execute(
        createToolCall("bash", { command: "exit 1" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Process exited with code 1");
    });

    it("should handle non-Error thrown values", async () => {
      const handler = createMockToolHandler("bash", async () => {
        throw "string error";
      });

      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const executor = new ToolExecutor(registry, permissions);

      const result = await executor.execute(
        createToolCall("bash", { command: "fail" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("string error");
    });
  });

  // -----------------------------------------------------------------------
  // Unknown tool handling
  // -----------------------------------------------------------------------

  describe("unknown tool handling", () => {
    it("should return error for unknown tool", async () => {
      const handlers = new Map<string, ToolHandler>();
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const executor = new ToolExecutor(registry, permissions);

      const result = await executor.execute(
        createToolCall("nonexistent_tool", {}),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown tool: nonexistent_tool");
      expect(result.output).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // Invalid arguments
  // -----------------------------------------------------------------------

  describe("invalid arguments", () => {
    it("should return error for invalid JSON arguments", async () => {
      const handler = createMockToolHandler("bash");
      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const executor = new ToolExecutor(registry, permissions);

      const toolCall: ToolCall = {
        id: "call_1",
        type: "function",
        function: {
          name: "bash",
          arguments: "not valid json {{{",
        },
      };

      const result = await executor.execute(toolCall);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid tool arguments");
    });
  });

  // -----------------------------------------------------------------------
  // Permission denied
  // -----------------------------------------------------------------------

  describe("permission denied", () => {
    it("should block execution when permission is denied", async () => {
      const executeFn = vi.fn(async () => ({ success: true, output: "ok" }));
      const handler = createMockToolHandler("bash", executeFn);

      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions({
        checkToolPermission: vi.fn(async () => ({
          allowed: false,
          reason: "Permission denied by user",
        })),
      });
      const executor = new ToolExecutor(registry, permissions);

      const result = await executor.execute(
        createToolCall("bash", { command: "rm -rf /" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Permission denied by user");
      // Handler should NOT have been called
      expect(executeFn).not.toHaveBeenCalled();
    });

    it("should use default message when reason is not provided", async () => {
      const handler = createMockToolHandler("bash");
      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions({
        checkToolPermission: vi.fn(async () => ({
          allowed: false,
        })),
      });
      const executor = new ToolExecutor(registry, permissions);

      const result = await executor.execute(
        createToolCall("bash", { command: "test" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Permission denied");
    });
  });

  // -----------------------------------------------------------------------
  // Pre-hook blocking
  // -----------------------------------------------------------------------

  describe("pre-hook blocking", () => {
    it("should block execution when pre-hook returns proceed=false", async () => {
      const executeFn = vi.fn(async () => ({ success: true, output: "ok" }));
      const handler = createMockToolHandler("file_write", executeFn);

      const handlers = new Map([["file_write", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const hookManager = createMockHookManager({
        runPreToolHooks: vi.fn(async () => ({
          proceed: false,
          message: "Blocked by security hook",
        })),
      });
      const executor = new ToolExecutor(registry, permissions, hookManager);

      const result = await executor.execute(
        createToolCall("file_write", { file_path: "/etc/passwd", content: "hack" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Blocked by security hook");
      // Handler should NOT have been called
      expect(executeFn).not.toHaveBeenCalled();
    });

    it("should use default message when hook message is not provided", async () => {
      const handler = createMockToolHandler("bash");
      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const hookManager = createMockHookManager({
        runPreToolHooks: vi.fn(async () => ({
          proceed: false,
        })),
      });
      const executor = new ToolExecutor(registry, permissions, hookManager);

      const result = await executor.execute(
        createToolCall("bash", { command: "test" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Blocked by pre-tool hook");
    });

    it("should proceed when pre-hook returns proceed=true", async () => {
      const executeFn = vi.fn(async () => ({ success: true, output: "written" }));
      const handler = createMockToolHandler("file_write", executeFn);

      const handlers = new Map([["file_write", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const hookManager = createMockHookManager({
        runPreToolHooks: vi.fn(async () => ({ proceed: true })),
      });
      const executor = new ToolExecutor(registry, permissions, hookManager);

      const result = await executor.execute(
        createToolCall("file_write", { file_path: "/tmp/test.ts", content: "code" }),
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe("written");
      expect(executeFn).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Post-hook execution
  // -----------------------------------------------------------------------

  describe("post-hook execution", () => {
    it("should run post-hooks after successful tool execution", async () => {
      const toolResult: ToolResult = { success: true, output: "done" };
      const handler = createMockToolHandler("bash", async () => toolResult);

      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const postHookFn = vi.fn(async () => {});
      const hookManager = createMockHookManager({
        runPostToolHooks: postHookFn,
      });
      const executor = new ToolExecutor(registry, permissions, hookManager);

      await executor.execute(createToolCall("bash", { command: "echo hi" }));

      expect(postHookFn).toHaveBeenCalledWith(
        "bash",
        { command: "echo hi" },
        toolResult,
      );
    });

    it("should not run post-hooks when tool execution throws", async () => {
      const handler = createMockToolHandler("bash", async () => {
        throw new Error("execution failed");
      });

      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const postHookFn = vi.fn(async () => {});
      const hookManager = createMockHookManager({
        runPostToolHooks: postHookFn,
      });
      const executor = new ToolExecutor(registry, permissions, hookManager);

      const result = await executor.execute(
        createToolCall("bash", { command: "fail" }),
      );

      expect(result.success).toBe(false);
      // Post-hooks should NOT be called when execution throws
      expect(postHookFn).not.toHaveBeenCalled();
    });

    it("should not run post-hooks when pre-hook blocks", async () => {
      const handler = createMockToolHandler("bash");
      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      const postHookFn = vi.fn(async () => {});
      const hookManager = createMockHookManager({
        runPreToolHooks: vi.fn(async () => ({
          proceed: false,
          message: "blocked",
        })),
        runPostToolHooks: postHookFn,
      });
      const executor = new ToolExecutor(registry, permissions, hookManager);

      await executor.execute(createToolCall("bash", { command: "test" }));

      expect(postHookFn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Without hook manager
  // -----------------------------------------------------------------------

  describe("without hook manager", () => {
    it("should work correctly without a hook manager", async () => {
      const handler = createMockToolHandler("file_read", async () => ({
        success: true,
        output: "contents",
      }));

      const handlers = new Map([["file_read", handler]]);
      const registry = createMockRegistry(handlers);
      const permissions = createMockPermissions();
      // No hookManager passed
      const executor = new ToolExecutor(registry, permissions);

      const result = await executor.execute(
        createToolCall("file_read", { file_path: "/tmp/test" }),
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe("contents");
    });
  });

  // -----------------------------------------------------------------------
  // Execution order
  // -----------------------------------------------------------------------

  describe("execution order", () => {
    it("should run permission check before pre-hooks", async () => {
      const callOrder: string[] = [];

      const handler = createMockToolHandler("bash", async () => ({
        success: true,
        output: "ok",
      }));
      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);

      const permissions = createMockPermissions({
        checkToolPermission: vi.fn(async () => {
          callOrder.push("permission");
          return { allowed: true };
        }),
      });

      const hookManager = createMockHookManager({
        runPreToolHooks: vi.fn(async () => {
          callOrder.push("pre-hook");
          return { proceed: true };
        }),
        runPostToolHooks: vi.fn(async () => {
          callOrder.push("post-hook");
        }),
      });

      const executor = new ToolExecutor(registry, permissions, hookManager);
      await executor.execute(createToolCall("bash", { command: "echo test" }));

      expect(callOrder).toEqual(["permission", "pre-hook", "post-hook"]);
    });

    it("should not run pre-hooks when permission denied", async () => {
      const preHookFn = vi.fn(async () => ({ proceed: true }));
      const handler = createMockToolHandler("bash");
      const handlers = new Map([["bash", handler]]);
      const registry = createMockRegistry(handlers);

      const permissions = createMockPermissions({
        checkToolPermission: vi.fn(async () => ({
          allowed: false,
          reason: "denied",
        })),
      });

      const hookManager = createMockHookManager({
        runPreToolHooks: preHookFn,
      });

      const executor = new ToolExecutor(registry, permissions, hookManager);
      await executor.execute(createToolCall("bash", { command: "test" }));

      expect(preHookFn).not.toHaveBeenCalled();
    });
  });
});
