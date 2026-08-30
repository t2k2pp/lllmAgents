import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubAgentManager } from "../../src/agent/sub-agent.js";
import type { SecurityConfig } from "../../src/config/types.js";
import type { ChatChunk, ChatParams, LLMProvider } from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { fileWriteTool } from "../../src/tools/definitions/file-write.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { resolveGitExecutable } from "../../src/git/git-command.js";
import { WorktreeManager } from "../../src/git/worktree-manager.js";
import { AgentDefinitionLoader } from "../../src/agents/agent-loader.js";
import {
  setSubAgentManager,
  taskApplyTool,
  taskDiffTool,
  taskListTool,
  taskOutputTool,
  taskTool,
} from "../../src/tools/definitions/task.js";

const roots: string[] = [];

function setup(): {
  root: string;
  repo: string;
  git: string;
  provider: LLMProvider;
  registry: ToolRegistry;
  config: SecurityConfig;
  manager: SubAgentManager;
} {
  const git = resolveGitExecutable();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-worktree-"));
  roots.push(root);
  const repo = path.join(root, "main");
  fs.mkdirSync(repo);
  execFileSync(git, ["init", "--quiet"], { cwd: repo });
  execFileSync(git, ["config", "user.name", "SubAgent Test"], { cwd: repo });
  execFileSync(git, ["config", "user.email", "subagent@example.invalid"], { cwd: repo });
  execFileSync(git, ["config", "core.autocrlf", "false"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
  execFileSync(git, ["add", "base.txt"], { cwd: repo });
  execFileSync(git, ["commit", "--quiet", "-m", "initial"], { cwd: repo });

  const chat = async function* (params: ChatParams): AsyncGenerator<ChatChunk> {
    const hasToolResult = params.messages.some((message) => message.role === "tool");
    if (!hasToolResult) {
      const prompt = String(params.messages.findLast((message) => message.role === "user")?.content ?? "result");
      yield {
        type: "tool_call",
        toolCall: {
          id: `write-${prompt}`,
          type: "function",
          function: { name: "file_write", arguments: JSON.stringify({ file_path: "same.txt", content: prompt }) },
        },
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text", text: "isolated edit complete" };
    yield { type: "done", finishReason: "stop" };
  };
  const provider = {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat,
    chatWithTools: chat,
    supportsVision: async () => false,
    chatWithVision: chat,
  } as unknown as LLMProvider;
  const registry = new ToolRegistry();
  registry.register(fileWriteTool);
  const config: SecurityConfig = {
    allowedDirectories: [root],
    blockedCommands: [],
    autoApproveTools: ["file_write"],
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
  };
  const worktrees = new WorktreeManager({ mainRoot: repo, managedRoot: path.join(root, "managed"), git });
  return {
    root,
    repo,
    git,
    provider,
    registry,
    config,
    manager: new SubAgentManager(
      provider,
      "test-model",
      registry,
      new PermissionManager(config),
      undefined,
      undefined,
      worktrees,
      repo,
    ),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SubAgentManager worktree lifecycle", () => {
  it("二つの並列agentが同名relative fileを独立編集し、mainは明示applyまで不変", async () => {
    const { repo, manager } = setup();
    const results = await manager.launchParallel([
      { type: "general-purpose", description: "alpha", prompt: "alpha", isolation: "worktree" },
      { type: "general-purpose", description: "beta", prompt: "beta", isolation: "worktree" },
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.workspaceState === "changed")).toBe(true);
    expect(new Set(results.map((result) => result.worktreePath)).size).toBe(2);
    expect(fs.existsSync(path.join(repo, "same.txt"))).toBe(false);
    expect(manager.diffWorktree(results[0].agentId).text).toContain(results[0].worktreePath ? "same.txt" : "never");

    manager.applyWorktree(results[0].agentId);
    expect(fs.readFileSync(path.join(repo, "same.txt"), "utf8")).toBe("alpha");
    expect(() => manager.applyWorktree(results[1].agentId)).toThrow(/main checkout.*untracked/i);
    manager.discardWorktree(results[1].agentId);
  }, 30_000);

  it("remote sourceとnested callerをworktreeからsharedへfallbackせず拒否する", async () => {
    const { manager } = setup();
    await expect(
      manager.launchForeground(
        "general-purpose",
        "remote",
        "x",
        undefined,
        undefined,
        undefined,
        undefined,
        "worktree",
        "discord",
      ),
    ).rejects.toThrow(/restricted to the local CLI.*自動切替/i);

    await expect(
      manager.launchForeground(
        "general-purpose",
        "nested",
        "x",
        new Set(["second"]),
        undefined,
        undefined,
        undefined,
        "worktree",
      ),
    ).rejects.toThrow(/main orchestrator.*自動降格/i);
  });

  it("task/list/output/diff/apply toolがisolation metadataと回収状態を一貫して返す", async () => {
    const { repo, manager } = setup();
    setSubAgentManager(manager);
    const launched = await taskTool.execute(
      {
        subagent_type: "general-purpose",
        description: "tool lifecycle",
        prompt: "from-tool",
        run_in_background: true,
        isolation: "worktree",
      },
      { ancestors: new Set(), source: "cli" },
    );
    expect(launched.success).toBe(true);
    const launchPayload = JSON.parse(launched.output);
    expect(launchPayload).toEqual(
      expect.objectContaining({ isolation: "worktree", workspaceState: "active", worktreePath: expect.any(String) }),
    );

    const output = await taskOutputTool.execute({ agent_id: launchPayload.agentId });
    const result = JSON.parse(output.output);
    expect(result).toEqual(
      expect.objectContaining({ isolation: "worktree", workspaceState: "changed", changedFiles: ["same.txt"] }),
    );
    const list = JSON.parse((await taskListTool.execute({})).output);
    expect(list.recoverableWorktrees).toEqual([
      expect.objectContaining({ agentId: launchPayload.agentId, workspaceState: "changed" }),
    ]);
    const diff = await taskDiffTool.execute({ agent_id: launchPayload.agentId });
    expect(diff.success).toBe(true);
    expect(JSON.parse(diff.output).text).toContain("from-tool");
    const applied = await taskApplyTool.execute({ agent_id: launchPayload.agentId });
    expect(applied.success).toBe(true);
    expect(fs.readFileSync(path.join(repo, "same.txt"), "utf8")).toBe("from-tool");
  });

  it("foreground task toolもworktree回収metadataを欠落させない", async () => {
    const { manager } = setup();
    setSubAgentManager(manager);
    const response = await taskTool.execute(
      {
        subagent_type: "general-purpose",
        description: "foreground lifecycle",
        prompt: "foreground-tool",
        isolation: "worktree",
      },
      { ancestors: new Set(), source: "cli" },
    );
    expect(response.success).toBe(true);
    const payload = JSON.parse(response.output);
    expect(payload).toEqual(
      expect.objectContaining({
        isolation: "worktree",
        workspaceId: expect.any(String),
        baseCommit: expect.any(String),
        worktreePath: expect.any(String),
        workspaceState: "changed",
        changedFiles: ["same.txt"],
      }),
    );
    manager.discardWorktree(payload.agentId);
  });

  it("agent定義でworktree必須ならcall-siteのshared指定で降格できない", async () => {
    const { root, repo, git, provider, registry, config } = setup();
    const agentsDir = path.join(root, "plugin", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "required.md"),
      [
        "---",
        "name: required",
        "description: isolated editor",
        "tools: [file_write]",
        "isolation: worktree",
        "---",
        "Edit only in the isolated workspace.",
      ].join("\n"),
      "utf8",
    );
    const loader = new AgentDefinitionLoader([
      { pluginName: "test", pluginRoot: path.join(root, "plugin"), path: agentsDir },
    ]);
    const manager = new SubAgentManager(
      provider,
      "test-model",
      registry,
      new PermissionManager(config),
      undefined,
      loader,
      new WorktreeManager({ mainRoot: repo, managedRoot: path.join(root, "required-managed"), git }),
      repo,
    );
    const result = await manager.launchForeground(
      "test:required",
      "cannot downgrade",
      "required-worktree",
      undefined,
      undefined,
      undefined,
      undefined,
      "shared",
    );
    expect(result).toEqual(expect.objectContaining({ isolation: "worktree", workspaceState: "changed" }));
    expect(fs.existsSync(path.join(repo, "same.txt"))).toBe(false);
    manager.discardWorktree(result.agentId);
  });

  it("変更後にbackground taskをcancelしても差分を保持し、取得後に回収できる", async () => {
    const { root, repo, registry, config, git } = setup();
    let waiting!: (signal: AbortSignal) => void;
    const waitingPromise = new Promise<AbortSignal>((resolve) => {
      waiting = resolve;
    });
    const chat = async function* (params: ChatParams): AsyncGenerator<ChatChunk> {
      const hasToolResult = params.messages.some((message) => message.role === "tool");
      if (!hasToolResult) {
        yield {
          type: "tool_call",
          toolCall: {
            id: "write-before-cancel",
            type: "function",
            function: {
              name: "file_write",
              arguments: JSON.stringify({ file_path: "cancelled.txt", content: "preserve me" }),
            },
          },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      const signal = params.signal;
      if (!signal) throw new Error("AbortSignal was not provided");
      waiting(signal);
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      yield { type: "done", finishReason: "stop" };
    };
    const provider = {
      providerType: "openai-compat",
      testConnection: async () => true,
      listModels: async () => [],
      getModelInfo: async () => ({}),
      chat,
      chatWithTools: chat,
      supportsVision: async () => false,
      chatWithVision: chat,
    } as unknown as LLMProvider;
    const manager = new SubAgentManager(
      provider,
      "test-model",
      registry,
      new PermissionManager(config),
      undefined,
      undefined,
      new WorktreeManager({ mainRoot: repo, managedRoot: path.join(root, "cancel-managed"), git }),
      repo,
    );
    const id = manager.launchBackground(
      "general-purpose",
      "cancelled isolated edit",
      "edit then wait",
      undefined,
      undefined,
      undefined,
      undefined,
      "worktree",
    );
    const signal = await waitingPromise;
    expect(manager.cancelBackground(id)).toBe("cancelled");
    expect(signal.aborted).toBe(true);

    const result = await manager.getResult(id);
    expect(result).toEqual(
      expect.objectContaining({
        agentId: id,
        success: false,
        result: "Cancelled by task_cancel.",
        isolation: "worktree",
        workspaceState: "changed",
        changedFiles: ["cancelled.txt"],
      }),
    );
    expect(fs.existsSync(path.join(repo, "cancelled.txt"))).toBe(false);
    expect(manager.diffWorktree(id).text).toContain("preserve me");
    manager.discardWorktree(id);
  });
});
