import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getHomedir } from "../utils/platform.js";
import * as logger from "../utils/logger.js";

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  allowedTools: string[];
  /** 起動時にsystem promptへ全文を注入するskill名。Codex/Claude Codeのagent skill preload相当。 */
  skills: string[];
  systemPrompt: string;
  source: string;
  /**
   * このエージェントを走らせるモデル参照 (frontmatter の `model:`)。 ModelRef 文法は
   * docs/model-orchestration.md §3.1。 未指定ならメインLLM で起動する (従来通り)。
   */
  modelRef?: string;
}

/**
 * Parse simple YAML frontmatter from a markdown file.
 * Supports: string values, flow-style arrays [a, b, c].
 */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content };
  }

  const yamlBlock = match[1];
  const body = match[2].trim();
  const meta: Record<string, unknown> = {};

  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value: string | string[] = trimmed.slice(colonIdx + 1).trim();

    // Parse flow-style array: [a, b, c]
    const arrayMatch = value.match(/^\[(.*)\]$/);
    if (arrayMatch) {
      meta[key] = arrayMatch[1]
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    } else {
      // Strip surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }
  }

  return { meta, body };
}

/**
 * Load a single agent definition from a .md file.
 */
function loadAgentFile(filePath: string): AgentDefinition | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(content);

    const name = meta.name as string | undefined;
    if (!name) {
      logger.warn(`Agent file missing 'name' in frontmatter: ${filePath}`);
      return null;
    }

    const description = (meta.description as string) ?? "";
    const tools = (meta.tools as string[]) ?? [];
    const allowedTools = (meta.allowedTools as string[]) ?? tools;
    const skills = Array.isArray(meta.skills)
      ? meta.skills.filter((value): value is string => typeof value === "string" && value.trim() !== "")
      : [];
    // model: は optional。 文字列以外 (flow 配列など) が来たら無視して従来動作にする。
    const rawModel = meta.model;
    const modelRef = typeof rawModel === "string" && rawModel.trim() !== "" ? rawModel.trim() : undefined;

    return {
      name,
      description,
      tools,
      allowedTools,
      skills,
      systemPrompt: body,
      source: filePath,
      modelRef,
    };
  } catch (e) {
    logger.debug(`Failed to load agent file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Scan a directory for .md agent definition files.
 * Returns all valid definitions found.
 */
function loadFromDirectory(dirPath: string): AgentDefinition[] {
  const results: AgentDefinition[] = [];
  try {
    if (!fs.existsSync(dirPath)) return results;

    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(dirPath, entry);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const def = loadAgentFile(filePath);
      if (def) {
        results.push(def);
      }
    }
  } catch (e) {
    logger.debug(`Failed to scan agent directory ${dirPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return results;
}

/**
 * Loads agent definitions from .md files with YAML frontmatter.
 *
 * Search paths (later paths override earlier for same name):
 *   1. src/agents/builtin/ または実行ファイル隣接 agents/ (built-in definitions)
 *   2. ~/.localllm/agents/  (user-global overrides)
 *   3. .localllm/agents/    (project-local overrides)
 */
export class AgentDefinitionLoader {
  private definitions = new Map<string, AgentDefinition>();
  private loaded = false;

  /**
   * Load all agent definitions from all search paths.
   * Later paths override earlier ones (project > user > builtin).
   */
  loadAll(): AgentDefinition[] {
    if (this.loaded) {
      return Array.from(this.definitions.values());
    }

    const searchPaths = this.getSearchPaths();

    for (const dirPath of searchPaths) {
      const defs = loadFromDirectory(dirPath);
      for (const def of defs) {
        this.definitions.set(def.name, def);
        logger.debug(`Loaded agent definition '${def.name}' from ${def.source}`);
      }
    }

    this.loaded = true;
    logger.debug(`Loaded ${this.definitions.size} agent definition(s) total`);
    return Array.from(this.definitions.values());
  }

  /**
   * Get an agent definition by name.
   * Calls loadAll() if not already loaded.
   */
  get(name: string): AgentDefinition | undefined {
    if (!this.loaded) {
      this.loadAll();
    }
    return this.definitions.get(name);
  }

  /**
   * Return the list of loaded agent names. Calls loadAll() if not already loaded.
   * Used by sub-agent.ts:resolveAgentConfig() to surface available types when an
   * unknown agent name is requested (ID-014 (a): 2026-05-01).
   */
  listNames(): string[] {
    if (!this.loaded) {
      this.loadAll();
    }
    return Array.from(this.definitions.keys());
  }

  /**
   * Return ordered search paths: builtin, user-global, project-local.
   */
  private getSearchPaths(): string[] {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    // 開発時は src/agents/builtin。bundle/SEA では Markdown は esbuild に埋め込まれないため、
    // build-deploy が実行ファイルの隣へ配置する agents/ も探索する。
    // CJS fallback は currentDir/agents、SEA は dirname(process.execPath)/agents で解決できる。
    const builtinPaths = [
      path.join(currentDir, "builtin"),
      path.join(currentDir, "agents"),
      path.join(path.dirname(process.execPath), "agents"),
    ];
    const userGlobalPath = path.join(getHomedir(), ".localllm", "agents");
    const projectLocalPath = path.resolve(".localllm", "agents");

    return [...new Set([...builtinPaths, userGlobalPath, projectLocalPath])];
  }
}
