import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityConfig } from "../../src/config/types.js";
import type {
  ChatChunk,
  ChatParams,
  ChatWithToolsParams,
  LLMProvider,
  Message,
} from "../../src/providers/base-provider.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { setSubAgentManager, taskTool } from "../../src/tools/definitions/task.js";

vi.mock("../../src/agents/agent-loader.js", () => ({
  AgentDefinitionLoader: class {
    loadAll() {
      return [this.get("general-purpose")];
    }

    get(name: string) {
      if (name !== "general-purpose") return undefined;
      return {
        name,
        description: "test agent",
        tools: [],
        allowedTools: [],
        skills: ["agent-skill"],
        systemPrompt: "BASE AGENT PROMPT",
        source: "/agents/general-purpose.md",
      };
    }

    listNames() {
      return ["general-purpose"];
    }
  },
}));

import { SubAgentManager } from "../../src/agent/sub-agent.js";

function securityConfig(): SecurityConfig {
  return {
    allowedDirectories: [],
    blockedCommands: [],
    autoApproveTools: [],
    requireApprovalTools: [],
    discordAutoApproveTools: [],
    slackAutoApproveTools: [],
    rules: { allow: [], deny: [], ask: [] },
  };
}

function captureProvider(captured: Message[][]): LLMProvider {
  const run = async function* (params: ChatParams | ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    captured.push(params.messages);
    yield { type: "text", text: "done" };
    yield { type: "done", finishReason: "stop" };
  };
  return {
    providerType: "openai-compat",
    testConnection: async () => true,
    listModels: async () => [],
    getModelInfo: async () => ({}),
    chat: run,
    chatWithTools: run,
    supportsVision: async () => false,
    chatWithVision: run,
  } as unknown as LLMProvider;
}

function registerSkill(registry: SkillRegistry, name: string, content: string, filePath: string): void {
  registry.register({
    name,
    description: `${name} description`,
    trigger: `/${name}`,
    content,
    filePath,
    builtIn: false,
  });
}

describe("sub-agent skill preloading", () => {
  let captured: Message[][];
  let skills: SkillRegistry;
  let permissions: PermissionManager;

  beforeEach(() => {
    captured = [];
    skills = new SkillRegistry();
    permissions = new PermissionManager(securityConfig());
    registerSkill(skills, "agent-skill", `AGENT SKILL at \${SKILL_DIR}`, "/skills/agent-skill/SKILL.md");
    registerSkill(skills, "call-skill", "CALL SKILL BODY", "/skills/call-skill/SKILL.md");
  });

  it("agent定義とtask呼出のskillsを重複除去してsystem promptへ順番に全文注入する", async () => {
    const manager = new SubAgentManager(
      captureProvider(captured),
      "test-model",
      new ToolRegistry(),
      permissions,
      skills,
    );

    const result = await manager.launchForeground(
      "general-purpose",
      "skill preload",
      "answer once",
      undefined,
      undefined,
      undefined,
      ["agent-skill", "call-skill"],
    );

    expect(result.success).toBe(true);
    const system = String(captured[0][0].content);
    expect(system).toContain("BASE AGENT PROMPT");
    expect(system).toContain('preloaded-skill name="agent-skill"');
    expect(system).toContain("AGENT SKILL at /skills/agent-skill");
    expect(system).not.toContain(`\${SKILL_DIR}`);
    expect(system).toContain('preloaded-skill name="call-skill"');
    expect(system.indexOf('name="agent-skill"')).toBeLessThan(system.indexOf('name="call-skill"'));
    expect(system.match(/name="agent-skill"/g)).toHaveLength(1);
  });

  it("不存在skillはモデルを呼ぶ前に名前付きで失敗する", async () => {
    const manager = new SubAgentManager(
      captureProvider(captured),
      "test-model",
      new ToolRegistry(),
      permissions,
      skills,
    );

    await expect(
      manager.launchForeground("general-purpose", "missing skill", "answer once", undefined, undefined, undefined, [
        "missing-skill",
      ]),
    ).rejects.toThrow("missing-skill");
    expect(captured).toHaveLength(0);
  });

  it("無効化skillも黙って省略せず失敗する", async () => {
    skills.disableSkill("call-skill");
    const manager = new SubAgentManager(
      captureProvider(captured),
      "test-model",
      new ToolRegistry(),
      permissions,
      skills,
    );

    await expect(
      manager.launchForeground("general-purpose", "disabled skill", "answer once", undefined, undefined, undefined, [
        "call-skill",
      ]),
    ).rejects.toThrow("call-skill");
    expect(captured).toHaveLength(0);
  });

  it("manual-only skillをsub-agent preloadで迂回起動しない", async () => {
    const manual = skills.get("call-skill");
    if (!manual) throw new Error("test skill missing");
    manual.disableModelInvocation = true;
    const manager = new SubAgentManager(
      captureProvider(captured),
      "test-model",
      new ToolRegistry(),
      permissions,
      skills,
    );
    await expect(
      manager.launchForeground("general-purpose", "manual skill", "answer once", undefined, undefined, undefined, [
        "call-skill",
      ]),
    ).rejects.toThrow("manual-only skill 'call-skill'");
    expect(captured).toHaveLength(0);
  });

  it("task toolが呼出時skills指定を公開する", () => {
    const properties = taskTool.definition.function.parameters.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("skills");
  });

  it("task toolのskillsをforeground起動へ渡す", async () => {
    const manager = new SubAgentManager(
      captureProvider(captured),
      "test-model",
      new ToolRegistry(),
      permissions,
      skills,
    );
    setSubAgentManager(manager);

    const result = await taskTool.execute({
      subagent_type: "general-purpose",
      description: "tool skill preload",
      prompt: "answer once",
      skills: ["call-skill"],
    });

    expect(result.success).toBe(true);
    expect(String(captured[0][0].content)).toContain('preloaded-skill name="call-skill"');
  });
});
