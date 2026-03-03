import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { HookManager } from "../../src/hooks/hook-manager.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("../../src/utils/platform.js", () => ({
  getHomedir: vi.fn(() => "/mock/home"),
  getShell: vi.fn(() => "/bin/sh"),
  isWindows: false,
}));

vi.mock("../../src/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// We mock fs selectively so loadFromFile works with our test data
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

// Get access to the mocked exec
import { exec } from "node:child_process";
const mockExec = vi.mocked(exec);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupHooksFile(filePath: string, hooks: unknown[]) {
  mockExistsSync.mockImplementation((p: fs.PathLike) => {
    if (String(p) === filePath) return true;
    return false;
  });
  mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
    if (String(p) === filePath) return JSON.stringify({ hooks });
    throw new Error(`File not found: ${p}`);
  });
}

function setupMultipleHooksFiles(fileMap: Record<string, unknown[]>) {
  mockExistsSync.mockImplementation((p: fs.PathLike) => {
    return String(p) in fileMap;
  });
  mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
    const key = String(p);
    if (key in fileMap) return JSON.stringify({ hooks: fileMap[key] });
    throw new Error(`File not found: ${p}`);
  });
}

function mockExecSuccess(stdout = "", stderr = "") {
  mockExec.mockImplementation((_cmd: string, _opts: any, callback: any) => {
    const child = { exitCode: 0 };
    if (typeof callback === "function") {
      process.nextTick(() => callback(null, stdout, stderr));
    }
    return child as any;
  });
}

function mockExecFailure(code: number, stderr = "", stdout = "") {
  mockExec.mockImplementation((_cmd: string, _opts: any, callback: any) => {
    const child = { exitCode: code };
    const error = Object.assign(new Error("command failed"), { code });
    if (typeof callback === "function") {
      process.nextTick(() => callback(error, stdout, stderr));
    }
    return child as any;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HookManager", () => {
  let manager: HookManager;

  beforeEach(() => {
    manager = new HookManager();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // loadHooks
  // -----------------------------------------------------------------------

  describe("loadHooks", () => {
    it("should load hooks from project-level hooks.json", () => {
      const projectDir = "/my/project";
      const hooksFilePath = path.join(projectDir, ".claude", "hooks.json");
      setupHooksFile(hooksFilePath, [
        { type: "PreToolUse", command: "echo pre", description: "pre hook" },
      ]);

      manager.loadHooks(projectDir);

      expect(manager.count).toBe(1);
      expect(manager.isLoaded).toBe(true);
    });

    it("should load hooks from .localllm project directory", () => {
      const projectDir = "/my/project";
      const hooksFilePath = path.join(projectDir, ".localllm", "hooks.json");
      setupHooksFile(hooksFilePath, [
        { type: "PostToolUse", command: "echo post" },
      ]);

      manager.loadHooks(projectDir);

      expect(manager.count).toBe(1);
    });

    it("should load hooks from user-global directory", () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "SessionStart", command: "echo start" },
        { type: "SessionStop", command: "echo stop" },
      ]);

      manager.loadHooks();

      expect(manager.count).toBe(2);
    });

    it("should merge hooks from multiple sources", () => {
      const projectDir = "/my/project";
      const claudeFile = path.join(projectDir, ".claude", "hooks.json");
      const globalFile = path.join("/mock/home", ".localllm", "hooks.json");

      setupMultipleHooksFiles({
        [claudeFile]: [
          { type: "PreToolUse", command: "echo pre-project" },
        ],
        [globalFile]: [
          { type: "PreToolUse", command: "echo pre-global" },
        ],
      });

      manager.loadHooks(projectDir);

      expect(manager.count).toBe(2);
    });

    it("should skip invalid hooks missing type or command", () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "PreToolUse" }, // missing command
        { command: "echo x" }, // missing type
        { type: "PreToolUse", command: "echo valid" },
      ]);

      manager.loadHooks();

      expect(manager.count).toBe(1);
    });

    it("should handle missing hooks files gracefully", () => {
      mockExistsSync.mockReturnValue(false);

      manager.loadHooks("/nonexistent");

      expect(manager.count).toBe(0);
      expect(manager.isLoaded).toBe(true);
    });

    it("should handle malformed JSON gracefully", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not valid json {{{");

      manager.loadHooks("/project");

      expect(manager.count).toBe(0);
      expect(manager.isLoaded).toBe(true);
    });

    it("should reset hooks on subsequent calls", () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "PreToolUse", command: "echo 1" },
        { type: "PreToolUse", command: "echo 2" },
      ]);

      manager.loadHooks();
      expect(manager.count).toBe(2);

      // On second call, should reset and reload
      setupHooksFile(globalPath, [
        { type: "PreToolUse", command: "echo 3" },
      ]);

      manager.loadHooks();
      expect(manager.count).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // runPreToolHooks
  // -----------------------------------------------------------------------

  describe("runPreToolHooks", () => {
    it("should proceed when no matching hooks", async () => {
      mockExistsSync.mockReturnValue(false);
      manager.loadHooks();

      const result = await manager.runPreToolHooks("file_read", {});
      expect(result.proceed).toBe(true);
    });

    it("should match hooks by tool name", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          matcher: { tool: "bash" },
          command: "echo check-bash",
        },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      const result = await manager.runPreToolHooks("bash", { command: "ls" });
      expect(result.proceed).toBe(true);
      expect(mockExec).toHaveBeenCalled();
    });

    it("should not run hooks when tool name does not match", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          matcher: { tool: "bash" },
          command: "echo check-bash",
        },
      ]);
      manager.loadHooks();

      const result = await manager.runPreToolHooks("file_read", {});
      expect(result.proceed).toBe(true);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("should match hooks with file pattern", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          matcher: { filePattern: "**/*.ts" },
          command: "echo check-ts",
        },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      const result = await manager.runPreToolHooks("file_write", {
        file_path: "src/index.ts",
      });
      expect(result.proceed).toBe(true);
      expect(mockExec).toHaveBeenCalled();
    });

    it("should not match hooks when file pattern does not match", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          matcher: { filePattern: "**/*.ts" },
          command: "echo check-ts",
        },
      ]);
      manager.loadHooks();

      const result = await manager.runPreToolHooks("file_write", {
        file_path: "src/index.js",
      });
      expect(result.proceed).toBe(true);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("should match hooks without matcher (matches all)", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          command: "echo always-run",
        },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      const result = await manager.runPreToolHooks("any_tool", {});
      expect(result.proceed).toBe(true);
      expect(mockExec).toHaveBeenCalled();
    });

    it("should block execution when hook exits with non-zero code", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          matcher: { tool: "bash" },
          command: "exit 1",
          description: "deny dangerous commands",
        },
      ]);
      manager.loadHooks();
      mockExecFailure(1, "blocked by policy");

      const result = await manager.runPreToolHooks("bash", { command: "rm -rf /" });
      expect(result.proceed).toBe(false);
      expect(result.message).toBe("blocked by policy");
    });

    it("should use stdout as message when stderr is empty on block", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          command: "exit 1",
        },
      ]);
      manager.loadHooks();
      mockExecFailure(1, "", "blocked from stdout");

      const result = await manager.runPreToolHooks("bash", {});
      expect(result.proceed).toBe(false);
      expect(result.message).toBe("blocked from stdout");
    });

    it("should use fallback message when both stderr and stdout are empty", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          command: "exit 1",
          description: "my-hook",
        },
      ]);
      manager.loadHooks();
      mockExecFailure(1, "", "");

      const result = await manager.runPreToolHooks("bash", {});
      expect(result.proceed).toBe(false);
      expect(result.message).toContain("Pre-hook blocked execution");
      expect(result.message).toContain("my-hook");
    });

    it("should run multiple matching hooks in order", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "PreToolUse", command: "echo first" },
        { type: "PreToolUse", command: "echo second" },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      const result = await manager.runPreToolHooks("any_tool", {});
      expect(result.proceed).toBe(true);
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    it("should stop at first blocking hook", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "PreToolUse", command: "exit 1" },
        { type: "PreToolUse", command: "echo should-not-run" },
      ]);
      manager.loadHooks();
      mockExecFailure(1, "blocked");

      const result = await manager.runPreToolHooks("any_tool", {});
      expect(result.proceed).toBe(false);
      // Only the first hook should have run
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it("should set TOOL_NAME and FILE_PATH env vars", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "PreToolUse", command: "echo check" },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      await manager.runPreToolHooks("file_write", { file_path: "/tmp/test.ts" });

      const callArgs = mockExec.mock.calls[0];
      const opts = callArgs[1] as any;
      expect(opts.env.TOOL_NAME).toBe("file_write");
      expect(opts.env.FILE_PATH).toBe("/tmp/test.ts");
    });
  });

  // -----------------------------------------------------------------------
  // runPostToolHooks
  // -----------------------------------------------------------------------

  describe("runPostToolHooks", () => {
    it("should run matching PostToolUse hooks", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PostToolUse",
          matcher: { tool: "bash" },
          command: "echo post",
        },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      await manager.runPostToolHooks("bash", { command: "ls" }, {
        success: true,
        output: "file1.ts\nfile2.ts",
      });

      expect(mockExec).toHaveBeenCalled();
    });

    it("should set TOOL_OUTPUT and TOOL_SUCCESS env vars", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "PostToolUse", command: "echo post" },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      await manager.runPostToolHooks("bash", {}, {
        success: true,
        output: "hello",
      });

      const callArgs = mockExec.mock.calls[0];
      const opts = callArgs[1] as any;
      expect(opts.env.TOOL_OUTPUT).toBe("hello");
      expect(opts.env.TOOL_SUCCESS).toBe("true");
    });

    it("should set TOOL_ERROR env var when result has error", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "PostToolUse", command: "echo post" },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      await manager.runPostToolHooks("bash", {}, {
        success: false,
        output: "",
        error: "command not found",
      });

      const callArgs = mockExec.mock.calls[0];
      const opts = callArgs[1] as any;
      expect(opts.env.TOOL_SUCCESS).toBe("false");
      expect(opts.env.TOOL_ERROR).toBe("command not found");
    });

    it("should not run hooks that do not match", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PostToolUse",
          matcher: { tool: "file_write" },
          command: "echo post-write",
        },
      ]);
      manager.loadHooks();

      await manager.runPostToolHooks("bash", {}, {
        success: true,
        output: "",
      });

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("should continue running hooks even if one fails", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "PostToolUse", command: "exit 1" },
        { type: "PostToolUse", command: "echo second" },
      ]);
      manager.loadHooks();

      // First call fails, second succeeds
      let callCount = 0;
      mockExec.mockImplementation((_cmd: string, _opts: any, callback: any) => {
        callCount++;
        const child = { exitCode: callCount === 1 ? 1 : 0 };
        const error = callCount === 1 ? Object.assign(new Error("fail"), { code: 1 }) : null;
        if (typeof callback === "function") {
          process.nextTick(() => callback(error, "", callCount === 1 ? "error output" : ""));
        }
        return child as any;
      });

      await manager.runPostToolHooks("any_tool", {}, {
        success: true,
        output: "",
      });

      // Both hooks should run (post-hooks do not stop on failure)
      expect(mockExec).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // runSessionHooks
  // -----------------------------------------------------------------------

  describe("runSessionHooks", () => {
    it("should run SessionStart hooks", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "SessionStart", command: "echo session started" },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      await manager.runSessionHooks("start");

      expect(mockExec).toHaveBeenCalled();
      const callArgs = mockExec.mock.calls[0];
      const opts = callArgs[1] as any;
      expect(opts.env.HOOK_TYPE).toBe("SessionStart");
    });

    it("should run SessionStop hooks", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "SessionStop", command: "echo session stopped" },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      await manager.runSessionHooks("stop");

      expect(mockExec).toHaveBeenCalled();
      const callArgs = mockExec.mock.calls[0];
      const opts = callArgs[1] as any;
      expect(opts.env.HOOK_TYPE).toBe("SessionStop");
    });

    it("should not run SessionStop hooks when running start", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "SessionStop", command: "echo stop" },
      ]);
      manager.loadHooks();

      await manager.runSessionHooks("start");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("should skip when no session hooks are defined", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "PreToolUse", command: "echo pre" },
      ]);
      manager.loadHooks();

      await manager.runSessionHooks("start");

      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Glob pattern matching
  // -----------------------------------------------------------------------

  describe("matcher with glob patterns", () => {
    it("should match simple wildcard patterns", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          matcher: { filePattern: "*.ts" },
          command: "echo ts-file",
        },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      // Should match .ts file
      const r1 = await manager.runPreToolHooks("file_write", { file_path: "index.ts" });
      expect(r1.proceed).toBe(true);
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it("should match ** globstar patterns", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          matcher: { filePattern: "src/**/*.test.ts" },
          command: "echo test-file",
        },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      const result = await manager.runPreToolHooks("file_write", {
        file_path: "src/utils/helper.test.ts",
      });
      expect(result.proceed).toBe(true);
      expect(mockExec).toHaveBeenCalled();
    });

    it("should not match when pattern does not apply", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          matcher: { filePattern: "*.test.ts" },
          command: "echo test-only",
        },
      ]);
      manager.loadHooks();

      const result = await manager.runPreToolHooks("file_write", {
        file_path: "src/index.ts",
      });
      expect(result.proceed).toBe(true);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("should not match when params have no file path", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          matcher: { filePattern: "**/*.ts" },
          command: "echo ts-file",
        },
      ]);
      manager.loadHooks();

      const result = await manager.runPreToolHooks("bash", { command: "ls" });
      expect(result.proceed).toBe(true);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("should extract file path from alternative params (path, pattern, command)", async () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        {
          type: "PreToolUse",
          matcher: { filePattern: "**/*.ts" },
          command: "echo check",
        },
      ]);
      manager.loadHooks();
      mockExecSuccess();

      // Using 'path' param
      const result = await manager.runPreToolHooks("grep", {
        path: "src/index.ts",
      });
      expect(result.proceed).toBe(true);
      expect(mockExec).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // isLoaded / count
  // -----------------------------------------------------------------------

  describe("properties", () => {
    it("should report isLoaded as false before loadHooks", () => {
      expect(manager.isLoaded).toBe(false);
    });

    it("should report isLoaded as true after loadHooks", () => {
      mockExistsSync.mockReturnValue(false);
      manager.loadHooks();
      expect(manager.isLoaded).toBe(true);
    });

    it("should report count accurately", () => {
      const globalPath = path.join("/mock/home", ".localllm", "hooks.json");
      setupHooksFile(globalPath, [
        { type: "PreToolUse", command: "a" },
        { type: "PostToolUse", command: "b" },
        { type: "SessionStart", command: "c" },
      ]);
      manager.loadHooks();
      expect(manager.count).toBe(3);
    });
  });
});
