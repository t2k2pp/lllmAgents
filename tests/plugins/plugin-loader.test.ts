import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectPluginDirs,
  expandPluginRoot,
  loadPluginBundles,
  loadPluginSkills,
} from "../../src/plugins/plugin-loader.js";

const tempDirs: string[] = [];
const PLUGIN_ROOT_TOKEN = `\${PLUGIN_ROOT}`;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-loader-test-"));
  tempDirs.push(dir);
  return dir;
}

function makePlugin(
  root: string,
  manifestDir: ".localllm-plugin" | ".codex-plugin" | ".claude-plugin" = ".localllm-plugin",
  manifest: Record<string, unknown> = { name: "quality-tools", version: "1.0.0" },
): void {
  fs.mkdirSync(path.join(root, manifestDir), { recursive: true });
  fs.writeFileSync(path.join(root, manifestDir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("collectPluginDirs", () => {
  it("configと反復可能なCLI指定をCWD基準で重複除去する", () => {
    const cwd = path.resolve("C:/workspace");
    expect(
      collectPluginDirs(["--plugin-dir", "./plugins/a", "--plugin-dir=./plugins/b"], ["./plugins/a"], cwd),
    ).toEqual([path.resolve(cwd, "plugins/a"), path.resolve(cwd, "plugins/b")]);
  });

  it("--plugin-dirの値が無ければfail-loudする", () => {
    expect(() => collectPluginDirs(["--plugin-dir"], [], process.cwd())).toThrow("--plugin-dir");
  });
});

describe("loadPluginBundles", () => {
  it.each([
    ".localllm-plugin",
    ".codex-plugin",
    ".claude-plugin",
  ] as const)("%s/plugin.jsonを互換manifestとして読む", (manifestDir) => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, "skills"));
    fs.mkdirSync(path.join(root, "agents"));
    fs.mkdirSync(path.join(root, "hooks"));
    fs.writeFileSync(path.join(root, "hooks", "hooks.json"), '{"hooks":[]}\n', "utf8");
    fs.writeFileSync(path.join(root, ".mcp.json"), '{"mcpServers":{}}\n', "utf8");
    makePlugin(root, manifestDir, {
      name: "quality-tools",
      version: "1.0.0",
      description: "Quality workflows",
      skills: "./skills",
      agents: "./agents",
      hooks: "./hooks/hooks.json",
      mcpServers: "./.mcp.json",
    });

    expect(loadPluginBundles([root])).toEqual([
      expect.objectContaining({
        name: "quality-tools",
        root: fs.realpathSync(root),
        manifestPath: path.join(fs.realpathSync(root), manifestDir, "plugin.json"),
        skillsDir: path.join(fs.realpathSync(root), "skills"),
        agentsDir: path.join(fs.realpathSync(root), "agents"),
        hooksFile: path.join(fs.realpathSync(root), "hooks", "hooks.json"),
        mcpFile: path.join(fs.realpathSync(root), ".mcp.json"),
      }),
    ]);
  });

  it("複数manifestがある曖昧なbundleを拒否する", () => {
    const root = makeTempDir();
    makePlugin(root, ".localllm-plugin");
    makePlugin(root, ".codex-plugin");
    expect(() => loadPluginBundles([root])).toThrow("複数");
  });

  it("同じplugin名を別rootから読み込むのを拒否する", () => {
    const a = makeTempDir();
    const b = makeTempDir();
    makePlugin(a);
    makePlugin(b);
    expect(() => loadPluginBundles([a, b])).toThrow("quality-tools");
  });

  it.each(["../outside", "C:/outside", "/outside"])("root外component path %s を拒否する", (skills) => {
    const root = makeTempDir();
    makePlugin(root, ".localllm-plugin", { name: "quality-tools", skills });
    expect(() => loadPluginBundles([root])).toThrow("plugin root");
  });

  it("symlinkでplugin root外へ抜けるcomponentを拒否する", () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    const link = path.join(root, "skills");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    makePlugin(root, ".localllm-plugin", { name: "quality-tools", skills: "./skills" });
    expect(() => loadPluginBundles([root])).toThrow("plugin root");
  });

  it("symlinkでplugin root外へ抜けるmanifestを拒否する", () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    makePlugin(outside);
    fs.symlinkSync(path.join(outside, ".localllm-plugin"), path.join(root, ".localllm-plugin"), "junction");
    expect(() => loadPluginBundles([root])).toThrow("manifest path");
  });

  it("不正UTF-8と1MiB超manifestを別々に拒否する", () => {
    const invalid = makeTempDir();
    fs.mkdirSync(path.join(invalid, ".localllm-plugin"));
    fs.writeFileSync(path.join(invalid, ".localllm-plugin", "plugin.json"), Buffer.from([0x82, 0xa0]));
    expect(() => loadPluginBundles([invalid])).toThrow("UTF-8");

    const huge = makeTempDir();
    makePlugin(huge, ".localllm-plugin", { name: "quality-tools", description: "x".repeat(1024 * 1024) });
    expect(() => loadPluginBundles([huge])).toThrow("1 MiB");
  });
});

describe("plugin component helpers", () => {
  it("skill名とtriggerをplugin名で名前空間化する", () => {
    const root = makeTempDir();
    const skillDir = path.join(root, "skills", "review");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\nDo the review.\n",
      "utf8",
    );
    makePlugin(root, ".localllm-plugin", { name: "quality-tools", skills: "./skills" });

    const [plugin] = loadPluginBundles([root]);
    expect(loadPluginSkills([plugin])).toEqual([
      expect.objectContaining({ name: "quality-tools:review", trigger: "/quality-tools:review", builtIn: false }),
    ]);
  });

  it("PLUGIN_ROOT tokenだけを実rootへ展開する", () => {
    expect(expandPluginRoot(`node ${PLUGIN_ROOT_TOKEN}/server.js`, "C:/plugin")).toBe(
      `node ${path.resolve("C:/plugin")}/server.js`,
    );
  });
});
