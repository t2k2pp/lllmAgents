import * as fs from "node:fs";
import * as path from "node:path";
import { loadSkillsFromDir } from "../skills/skill-loader.js";
import type { SkillDefinition } from "../skills/skill-registry.js";

const MANIFEST_RELATIVE_PATHS = [
  path.join(".localllm-plugin", "plugin.json"),
  path.join(".codex-plugin", "plugin.json"),
  path.join(".claude-plugin", "plugin.json"),
] as const;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PLUGINS = 32;
const PLUGIN_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PLUGIN_ROOT_TOKEN = `\${PLUGIN_ROOT}`;

interface PluginManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  skills?: unknown;
  agents?: unknown;
  hooks?: unknown;
  mcpServers?: unknown;
}

export interface LoadedPlugin {
  name: string;
  version?: string;
  description?: string;
  root: string;
  manifestPath: string;
  skillsDir?: string;
  agentsDir?: string;
  hooksFile?: string;
  mcpFile?: string;
}

export interface PluginComponentSource {
  pluginName: string;
  pluginRoot: string;
  path: string;
}

/** CLIの反復指定とconfig指定を、指定順を保って絶対pathへ正規化する。 */
export function collectPluginDirs(args: string[], configuredDirs: string[] = [], cwd = process.cwd()): string[] {
  const rawDirs = [...configuredDirs];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--plugin-dir") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--plugin-dir にはplugin directory pathが必要です");
      }
      rawDirs.push(value);
      i++;
    } else if (arg.startsWith("--plugin-dir=")) {
      const value = arg.slice("--plugin-dir=".length);
      if (!value) throw new Error("--plugin-dir にはplugin directory pathが必要です");
      rawDirs.push(value);
    }
  }

  if (rawDirs.length > MAX_PLUGINS) {
    throw new Error(`pluginは最大${MAX_PLUGINS}件まで指定できます`);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawDirs) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error("plugin directory pathは空にできません");
    }
    const resolved = path.resolve(cwd, raw);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

/** manifestを検証し、明示指定されたローカルbundleをロードする。 */
export function loadPluginBundles(pluginDirs: string[]): LoadedPlugin[] {
  if (pluginDirs.length > MAX_PLUGINS) {
    throw new Error(`pluginは最大${MAX_PLUGINS}件まで指定できます`);
  }

  const plugins: LoadedPlugin[] = [];
  const names = new Map<string, string>();
  for (const requestedRoot of pluginDirs) {
    if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
      throw new Error(`[plugin] directoryが存在しません: ${requestedRoot}`);
    }
    const root = fs.realpathSync(requestedRoot);
    const manifestCandidates = MANIFEST_RELATIVE_PATHS.map((relativePath) => path.join(root, relativePath)).filter(
      (candidate) => fs.existsSync(candidate),
    );
    if (manifestCandidates.length === 0) {
      throw new Error(`[plugin] plugin.jsonが見つかりません: ${root}`);
    }
    if (manifestCandidates.length > 1) {
      throw new Error(`[plugin] 複数のplugin manifestがあり曖昧です: ${manifestCandidates.join(", ")}`);
    }

    const manifestPath = fs.realpathSync(manifestCandidates[0]);
    if (!isWithin(root, manifestPath)) {
      throw new Error(`[plugin] manifest pathがsymlink経由でplugin root外を参照しています: ${manifestCandidates[0]}`);
    }
    const manifest = readManifest(manifestPath);
    if (typeof manifest.name !== "string" || !PLUGIN_NAME.test(manifest.name)) {
      throw new Error(`[plugin] nameは64文字以下のkebab-caseで指定してください: ${manifestPath}`);
    }
    const previousRoot = names.get(manifest.name);
    if (previousRoot) {
      throw new Error(`[plugin] plugin名 '${manifest.name}' が重複しています: ${previousRoot}, ${root}`);
    }
    names.set(manifest.name, root);

    const skillsDir = resolveComponent(root, manifest.skills, "skills", "directory");
    const agentsDir = resolveComponent(root, manifest.agents, "agents", "directory");
    const hooksFile = resolveComponent(root, manifest.hooks, path.join("hooks", "hooks.json"), "file");
    const mcpFile = resolveComponent(root, manifest.mcpServers, ".mcp.json", "file");

    plugins.push({
      name: manifest.name,
      version: optionalString(manifest.version, "version", manifestPath),
      description: optionalString(manifest.description, "description", manifestPath),
      root,
      manifestPath,
      skillsDir,
      agentsDir,
      hooksFile,
      mcpFile,
    });
  }
  return plugins;
}

/** plugin skillは既存名を上書きできないよう、名前とtriggerをplugin単位で名前空間化する。 */
export function loadPluginSkills(plugins: LoadedPlugin[]): SkillDefinition[] {
  const result: SkillDefinition[] = [];
  for (const plugin of plugins) {
    if (!plugin.skillsDir) continue;
    const seen = new Set<string>();
    for (const skill of loadSkillsFromDir(plugin.skillsDir, false)) {
      if (seen.has(skill.name)) {
        throw new Error(`[plugin] '${plugin.name}' 内でskill名 '${skill.name}' が重複しています`);
      }
      seen.add(skill.name);
      const qualifiedName = `${plugin.name}:${skill.name}`;
      result.push({
        ...skill,
        name: qualifiedName,
        trigger: `/${qualifiedName}`,
        builtIn: false,
      });
    }
  }
  return result;
}

export function getPluginAgentSources(plugins: LoadedPlugin[]): PluginComponentSource[] {
  return plugins.flatMap((plugin) =>
    plugin.agentsDir ? [{ pluginName: plugin.name, pluginRoot: plugin.root, path: plugin.agentsDir }] : [],
  );
}

export function getPluginHookSources(plugins: LoadedPlugin[]): PluginComponentSource[] {
  return plugins.flatMap((plugin) =>
    plugin.hooksFile ? [{ pluginName: plugin.name, pluginRoot: plugin.root, path: plugin.hooksFile }] : [],
  );
}

export function getPluginMcpSources(plugins: LoadedPlugin[]): PluginComponentSource[] {
  return plugins.flatMap((plugin) =>
    plugin.mcpFile ? [{ pluginName: plugin.name, pluginRoot: plugin.root, path: plugin.mcpFile }] : [],
  );
}

export function expandPluginRoot(value: string, pluginRoot: string): string {
  return value.replaceAll(PLUGIN_ROOT_TOKEN, path.resolve(pluginRoot));
}

function readManifest(manifestPath: string): PluginManifest {
  const stat = fs.statSync(manifestPath);
  if (!stat.isFile()) throw new Error(`[plugin] manifestがfileではありません: ${manifestPath}`);
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`[plugin] manifestは1 MiB以下にしてください: ${manifestPath}`);
  }
  const bytes = fs.readFileSync(manifestPath);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`[plugin] manifestは有効なUTF-8で保存してください: ${manifestPath}`);
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as PluginManifest;
  } catch (error) {
    throw new Error(`[plugin] manifest JSONが不正です: ${manifestPath}: ${String(error)}`);
  }
}

function optionalString(value: unknown, field: string, manifestPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[plugin] ${field}は空でないstringにしてください: ${manifestPath}`);
  }
  return value;
}

function resolveComponent(
  root: string,
  declared: unknown,
  conventionalPath: string,
  expected: "file" | "directory",
): string | undefined {
  if (declared === undefined) {
    const conventional = path.join(root, conventionalPath);
    if (!fs.existsSync(conventional)) return undefined;
    return validateComponentPath(root, `./${conventionalPath.replaceAll("\\", "/")}`, expected);
  }
  if (typeof declared !== "string" || declared.trim() === "") {
    throw new Error(`[plugin] ${conventionalPath} component pathはstringで指定してください`);
  }
  return validateComponentPath(root, declared, expected);
}

function validateComponentPath(root: string, declared: string, expected: "file" | "directory"): string {
  if (path.isAbsolute(declared) || !(declared.startsWith("./") || declared.startsWith(".\\"))) {
    throw new Error(`[plugin] component pathはplugin root内の./相対pathにしてください: ${declared}`);
  }
  const lexicalTarget = path.resolve(root, declared);
  if (!isWithin(root, lexicalTarget)) {
    throw new Error(`[plugin] component pathがplugin root外を参照しています: ${declared}`);
  }
  if (!fs.existsSync(lexicalTarget)) {
    throw new Error(`[plugin] componentが存在しません: ${lexicalTarget}`);
  }
  const target = fs.realpathSync(lexicalTarget);
  if (!isWithin(root, target)) {
    throw new Error(`[plugin] component pathがsymlink経由でplugin root外を参照しています: ${declared}`);
  }
  const stat = fs.statSync(target);
  if ((expected === "file" && !stat.isFile()) || (expected === "directory" && !stat.isDirectory())) {
    throw new Error(`[plugin] componentは${expected}である必要があります: ${target}`);
  }
  return target;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
