import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecurityConfig } from "../../src/config/types.js";
import { createSharedWorkspace, type WorkspaceContext } from "../../src/agent/workspace-context.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { bashTool } from "../../src/tools/definitions/bash.js";
import { fileWriteTool } from "../../src/tools/definitions/file-write.js";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const roots: string[] = [];

function security(root: string): SecurityConfig {
  return {
    allowedDirectories: [root],
    blockedCommands: [],
    autoApproveTools: ["file_write", "bash", "plugin_write"],
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
  };
}

function fixture(): { main: string; worktree: string; workspace: WorkspaceContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-boundary-"));
  roots.push(root);
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(main);
  fs.mkdirSync(worktree);
  return {
    main,
    worktree,
    workspace: {
      mode: "worktree",
      root: worktree,
      mainCheckoutRoot: main,
      workspaceId: "ws-test",
      baseCommit: "abc",
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ToolExecutor worktree boundary", () => {
  it("relative file_writeをworktree rootへ解決し、main checkoutを不変に保つ", async () => {
    const { main, worktree, workspace } = fixture();
    const registry = new ToolRegistry();
    registry.register(fileWriteTool);
    const executor = new ToolExecutor(
      registry,
      new PermissionManager(security(path.dirname(main))),
      undefined,
      undefined,
      undefined,
      workspace,
    );

    const result = await executor.execute({
      id: "write",
      type: "function",
      function: { name: "file_write", arguments: JSON.stringify({ file_path: "same.txt", content: "isolated" }) },
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(worktree, "same.txt"), "utf8")).toBe("isolated");
    expect(fs.existsSync(path.join(main, "same.txt"))).toBe(false);
  });

  it("main絶対path、parent traversal、git redirectをpermission前に恒久拒否する", async () => {
    const { main, workspace } = fixture();
    const registry = new ToolRegistry();
    registry.register(fileWriteTool);
    registry.register(bashTool);
    const executor = new ToolExecutor(
      registry,
      new PermissionManager(security(path.dirname(main))),
      undefined,
      undefined,
      undefined,
      workspace,
    );

    const absolute = await executor.execute({
      id: "absolute",
      type: "function",
      function: {
        name: "file_write",
        arguments: JSON.stringify({ file_path: path.join(main, "bad.txt"), content: "x" }),
      },
    });
    expect(absolute).toEqual(expect.objectContaining({ success: false, errorKind: "permanent" }));

    const traversal = await executor.execute({
      id: "traversal",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "node ../escape.js" }) },
    });
    expect(traversal.error).toMatch(/parent-directory/i);

    const redirect = await executor.execute({
      id: "redirect",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: `git -C "${main}" status` }) },
    });
    expect(redirect.error).toMatch(/Git directory redirection/i);
  });

  it("検証済みpolicyの無いplugin/MCP toolをworktree agentから実行しない", async () => {
    const { main, workspace } = fixture();
    const registry = new ToolRegistry();
    registry.register({
      name: "plugin_write",
      definition: {
        type: "function",
        function: {
          name: "plugin_write",
          description: "unknown side effect",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => ({ success: true, output: "should not run" }),
    });
    const executor = new ToolExecutor(
      registry,
      new PermissionManager(security(path.dirname(main))),
      undefined,
      undefined,
      undefined,
      workspace,
    );
    const result = await executor.execute({
      id: "plugin",
      type: "function",
      function: { name: "plugin_write", arguments: "{}" },
    });
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        errorKind: "permanent",
        error: expect.stringContaining("no verified"),
      }),
    );
  });

  it("存在しない子pathでもsymlink/junction経由のmain checkout到達を拒否する", async () => {
    const { main, worktree, workspace } = fixture();
    const link = path.join(worktree, "redirect");
    fs.symlinkSync(main, link, process.platform === "win32" ? "junction" : "dir");
    const registry = new ToolRegistry();
    registry.register(fileWriteTool);
    const executor = new ToolExecutor(
      registry,
      new PermissionManager(security(path.dirname(main))),
      undefined,
      undefined,
      undefined,
      workspace,
    );
    const result = await executor.execute({
      id: "junction",
      type: "function",
      function: {
        name: "file_write",
        arguments: JSON.stringify({ file_path: "redirect/new/deep.txt", content: "escape" }),
      },
    });
    expect(result).toEqual(expect.objectContaining({ success: false, errorKind: "permanent" }));
    expect(fs.existsSync(path.join(main, "new", "deep.txt"))).toBe(false);
  });

  it("shared workspaceでは既存のprocess-local behaviorを維持する", () => {
    const shared = createSharedWorkspace();
    expect(shared.mode).toBe("shared");
    expect(shared.root).toBe(shared.mainCheckoutRoot);
  });

  it.runIf(process.platform === "win32")(
    "Native Windowsのworktree bashは実行せず、WSL2またはfile toolを案内する",
    async () => {
      const { main, workspace } = fixture();
      const registry = new ToolRegistry();
      registry.register(bashTool);
      const executor = new ToolExecutor(
        registry,
        new PermissionManager(security(path.dirname(main))),
        undefined,
        undefined,
        undefined,
        workspace,
      );
      const result = await executor.execute({
        id: "native-windows",
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) },
      });
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          errorKind: "permanent",
          error: expect.stringMatching(/Native Windows.*WSL2.*自動切替しません/),
        }),
      );
    },
  );
});
