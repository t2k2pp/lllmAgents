export interface AgentDefinition {
    name: string;
    description: string;
    tools: string[];
    allowedTools: string[];
    systemPrompt: string;
    source: string;
}
/**
 * Loads agent definitions from .md files with YAML frontmatter.
 *
 * Search paths (later paths override earlier for same name):
 *   1. src/agents/builtin/  (built-in definitions)
 *   2. ~/.localllm/agents/  (user-global overrides)
 *   3. .localllm/agents/    (project-local overrides)
 */
export declare class AgentDefinitionLoader {
    private definitions;
    private loaded;
    /**
     * Load all agent definitions from all search paths.
     * Later paths override earlier ones (project > user > builtin).
     */
    loadAll(): AgentDefinition[];
    /**
     * Get an agent definition by name.
     * Calls loadAll() if not already loaded.
     */
    get(name: string): AgentDefinition | undefined;
    /**
     * Return ordered search paths: builtin, user-global, project-local.
     */
    private getSearchPaths;
}
//# sourceMappingURL=agent-loader.d.ts.map