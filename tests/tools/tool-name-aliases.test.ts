import { describe, it, expect } from "vitest";
import { resolveToolAlias } from "../../src/tools/tool-name-aliases.js";
import { evaluateRules } from "../../src/security/rule-engine.js";
import { parseSkillFile } from "../../src/skills/skill-loader.js";
import { taskTool } from "../../src/tools/definitions/task.js";

describe("ツール名の別名表 (権限ルールとスキルで共通)", () => {
  it("Claude Code 式の名前を内部名に変換する (大文字小文字は区別しない)", () => {
    expect(resolveToolAlias("Bash")).toBe("bash");
    expect(resolveToolAlias("Read")).toBe("file_read");
    expect(resolveToolAlias("write")).toBe("file_write");
    expect(resolveToolAlias("Edit")).toBe("file_edit");
    expect(resolveToolAlias("WebFetch")).toBe("web_fetch");
    expect(resolveToolAlias("WebSearch")).toBe("web_search");
  });

  it("Agent / Task は実在するサブエージェントツール task を指す (旧表の sub_agent は実在しない名前だった)", () => {
    expect(resolveToolAlias("Agent")).toBe("task");
    expect(resolveToolAlias("Task")).toBe("task");
    expect(taskTool.name).toBe("task");
  });

  it("内部名や未知の名前はそのまま返す", () => {
    expect(resolveToolAlias("file_read")).toBe("file_read");
    expect(resolveToolAlias("mcp__x__y")).toBe("mcp__x__y");
  });

  it("権限ルールの Agent はサブエージェント (task) の呼び出しにマッチする", () => {
    expect(evaluateRules({ allow: [], deny: ["Agent"], ask: [] }, "task", {})).toBe("deny");
  });

  it("スキルの allowed-tools でも同じ表で変換される", () => {
    const skill = parseSkillFile(
      "---\nname: alias-test\ndescription: test\nallowed-tools: Read, Bash, Agent\n---\nbody\n",
      "/tmp/alias-test/SKILL.md",
      false,
    );
    expect(skill?.tools).toEqual(["file_read", "bash", "task"]);
  });
});
