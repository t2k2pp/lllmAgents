import * as path from "node:path";
import chalk from "chalk";
import type { ToolHandler } from "../tool-registry.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import type { PermissionManager } from "../../security/permission-manager.js";

let skillRegistry: SkillRegistry | null = null;
let permissionManager: PermissionManager | null = null;

export function setSkillRegistry(registry: SkillRegistry): void {
  skillRegistry = registry;
}

export function setSkillPermissionManager(pm: PermissionManager): void {
  permissionManager = pm;
}

export const skillTool: ToolHandler = {
  name: "skill",
  definition: {
    type: "function",
    function: {
      name: "skill",
      description: `スキルを名前またはトリガーで実行する。
スキルはワークフロー定義とドメイン知識を含むテンプレートで、
特定のタスク（コミット、コードレビュー、TDD等）を効率的に実行できる。

利用可能なスキルは /skill コマンドで確認可能。`,
      parameters: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description: "スキル名またはトリガー名 (例: 'commit', 'tdd', 'pr-review')",
          },
          args: {
            type: "string",
            description: "スキルに渡す引数（オプション）",
          },
        },
        required: ["skill_name"],
      },
    },
  },

  async execute(params: Record<string, unknown>) {
    if (!skillRegistry) {
      return { success: false, output: "", error: "SkillRegistry not initialized" };
    }

    const name = params.skill_name as string;
    const args = (params.args as string) ?? "";

    const skill = skillRegistry.get(name);
    if (!skill) {
      // List available skills
      const available = skillRegistry.list();
      const list = available.map((s) => `  ${s.trigger} - ${s.description}`).join("\n");
      return {
        success: false,
        output: "",
        error: `スキル '${name}' が見つかりません。\n利用可能なスキル:\n${list}`,
      };
    }

    console.log(chalk.dim(`\n  [Skill] ${skill.trigger}: ${skill.description}`));

    // Resolve skill directory for script references
    const skillDir = path.dirname(skill.filePath);

    // Allow the skill's directory in the sandbox so scripts can be read for debugging
    if (permissionManager) {
      permissionManager.addAllowedDir(skillDir);
    }

    // Replace ${SKILL_DIR} placeholder with the absolute skill directory path
    const resolvedContent = skill.content.replace(/\$\{SKILL_DIR\}/g, skillDir);

    // Return the skill content as instructions for the LLM to follow
    const output = [
      `<skill-loaded name="${skill.name}" trigger="${skill.trigger}" skill-dir="${skillDir}">`,
      resolvedContent,
      args ? `\n引数: ${args}` : "",
      `</skill-loaded>`,
      "",
      `スキルのスクリプト/リソースのパス: ${skillDir}`,
      "上記のスキル指示に従ってタスクを実行してください。",
    ].join("\n");

    return {
      success: true,
      output,
    };
  },
};
