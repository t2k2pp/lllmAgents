import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import { setSkillRegistry, skillTool } from "../../src/tools/definitions/skill.js";
import { createWorkflowLearningTools } from "../../src/tools/definitions/workflow-learn.js";
import type { ToolHandler } from "../../src/tools/tool-registry.js";
import { WorkflowLearner } from "../../src/workflow-learning/workflow-learner.js";

const dirs: string[] = [];

function find(tools: ToolHandler[], name: string): ToolHandler {
  const hit = tools.find((tool) => tool.name === name);
  if (!hit) throw new Error(`missing tool ${name}`);
  return hit;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("workflow learning tools", () => {
  it("remote surfaceからのrecordingを拒否する", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-learn-tools-"));
    dirs.push(root);
    const learner = new WorkflowLearner(root);
    learner.wrapTool({
      name: "browser_click",
      definition: {
        type: "function",
        function: { name: "browser_click", description: "click", parameters: { type: "object", properties: {} } },
      },
      async execute() {
        return { success: true, output: "ok" };
      },
    });
    const tools = createWorkflowLearningTools(learner, new SkillRegistry());
    const result = await find(tools, "workflow_learn_start").execute(
      { name: "remote", description: "remote demo", scope: "browser" },
      { ancestors: new Set(), source: "slack", workspace: { mode: "shared", root } },
    );
    expect(result).toMatchObject({ success: false, errorKind: "permanent" });
    expect(learner.status().active).toBe(false);
  });

  it("manual-only skillをmodelのskill toolから起動させない", async () => {
    const registry = new SkillRegistry();
    registry.register({
      name: "manual-operation",
      description: "manual",
      trigger: "/manual-operation",
      content: "run browser actions",
      filePath: "C:/skills/manual-operation/SKILL.md",
      builtIn: false,
      disableModelInvocation: true,
    });
    setSkillRegistry(registry);
    const result = await skillTool.execute({ skill_name: "manual-operation" });
    expect(result).toMatchObject({ success: false, errorKind: "permanent" });
    expect(result.error).toContain("手動起動専用");
    expect(result.error).toContain("/manual-operation");
  });
});
