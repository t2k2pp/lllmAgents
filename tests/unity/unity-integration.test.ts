import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildUnityBundle, runUnityCommand, UNITY_REVISION } from "../../src/unity/unity-integration.js";
import { loadPluginBundles, loadPluginSkills, getPluginMcpSources } from "../../src/plugins/plugin-loader.js";
import { MCPManager } from "../../src/mcp/mcp-manager.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity integration "));
  roots.push(root);
  const source = path.join(root, "source");
  const project = path.join(root, "project");
  for (const dir of [
    "source/.codex-plugin",
    "source/.claude-plugin",
    "source/skills/unity-cli/references",
    "project/ProjectSettings",
    "project/Packages",
  ])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(
    path.join(source, ".codex-plugin/plugin.json"),
    JSON.stringify({ name: "unity", version: "0.1.6-beta" }),
  );
  fs.writeFileSync(path.join(source, ".claude-plugin/plugin.json"), JSON.stringify({ name: "unity" }));
  fs.writeFileSync(path.join(source, "LICENSE.md"), "fixture license");
  fs.writeFileSync(
    path.join(source, "skills/unity-cli/SKILL.md"),
    "---\nname: unity-cli\ndescription: >-\n  Control Unity\n  with CLI\nallowed-tools:\n  - Bash\n---\nRead [details](references/details.md).\n",
  );
  fs.writeFileSync(path.join(source, "skills/unity-cli/references/details.md"), "reference");
  fs.writeFileSync(path.join(project, "ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 6000.0.1f1");
  fs.writeFileSync(path.join(project, "Packages/manifest.json"), "{}");
  return { source, project };
}

describe("Unity local model integration", () => {
  it("adapts both-manifest source, preserves references, binds MCP to project without launching it", () => {
    const { source, project } = fixture();
    const bundle = buildUnityBundle(source, project, UNITY_REVISION, "missing-unity-test-executable");
    const plugins = loadPluginBundles([bundle]);
    expect(loadPluginSkills(plugins)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "unity:unity-cli", tools: ["bash"], description: "Control Unity with CLI" }),
      ]),
    );
    expect(fs.readFileSync(path.join(bundle, "skills/unity-cli/references/details.md"), "utf8")).toBe("reference");
    expect(fs.readFileSync(path.join(bundle, "LICENSE.md"), "utf8")).toBe("fixture license");
    const config = new MCPManager(project, getPluginMcpSources(plugins)).loadConfig();
    expect(config.unity__editor).toMatchObject({
      command: "missing-unity-test-executable",
      args: ["mcp", "--project-path", fs.realpathSync(project)],
      transport: "stdio",
      permissionLevel: "ask",
    });
    expect(buildUnityBundle(source, project, UNITY_REVISION, "missing-unity-test-executable")).toBe(bundle);
  });
  it("keeps previous bundles when updating and detects a modified installation", () => {
    const { source, project } = fixture();
    const first = buildUnityBundle(source, project, UNITY_REVISION);
    const second = buildUnityBundle(source, project, "a".repeat(40));
    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(true);
    fs.writeFileSync(path.join(first, "LICENSE.md"), "tampered");
    expect(() => buildUnityBundle(source, project, UNITY_REVISION)).toThrow("modified");
  });
  it("rejects missing skills and leaves no partial bundle", () => {
    const { source, project } = fixture();
    fs.writeFileSync(path.join(source, "skills/unity-cli/SKILL.md"), "invalid");
    expect(() => buildUnityBundle(source, project, UNITY_REVISION)).toThrow("incomplete");
    expect(fs.readdirSync(path.join(project, ".localllm/unity/bundles"))).toEqual([]);
  });
  it("rejects unsupported options before starting processes", () => {
    expect(() => runUnityCommand(["setup"])).toThrow("--project");
    expect(() => runUnityCommand(["setup", "--project", "x", "--unknown", "y"])).toThrow("Invalid");
    expect(() => runUnityCommand(["doctor", "--revision", "abc"])).toThrow("Invalid");
    const { source, project } = fixture();
    expect(() => buildUnityBundle(source, project, "main")).toThrow("SHA");
  });
});
