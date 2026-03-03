export type ContextMode = "dev" | "review" | "research";

interface ModeDefinition {
  name: string;
  description: string;
  priority: string;
  behavior: string;
  preferredTools: string[];
}

const MODE_DEFINITIONS: Record<ContextMode, ModeDefinition> = {
  dev: {
    name: "Development",
    description: "Active development mode",
    priority: "Work -> Correct -> Clean",
    behavior: "Write code first, test after, commit atomically",
    preferredTools: ["file_write", "file_edit", "bash", "task"],
  },
  review: {
    name: "Code Review",
    description: "Code review mode",
    priority: "Critical > High > Medium > Low",
    behavior: "Thorough analysis, severity-based prioritization, provide solutions",
    preferredTools: ["file_read", "grep", "glob"],
  },
  research: {
    name: "Research",
    description: "Research and exploration mode",
    priority: "Understand -> Verify -> Document",
    behavior: "Explore and learn, read broadly, summarize findings",
    preferredTools: ["file_read", "grep", "glob", "web_fetch", "web_search"],
  },
};

export class ContextModeManager {
  currentMode: ContextMode = "dev";

  switchMode(mode: ContextMode): void {
    this.currentMode = mode;
  }

  getPromptSection(): string {
    const def = MODE_DEFINITIONS[this.currentMode];
    return `
# Context Mode: ${def.name}
- Priority: ${def.priority}
- Behavior: ${def.behavior}
- Preferred tools: ${def.preferredTools.join(", ")}`;
  }

  getModeInfo(): { name: string; description: string; priority: string } {
    const def = MODE_DEFINITIONS[this.currentMode];
    return {
      name: def.name,
      description: def.description,
      priority: def.priority,
    };
  }
}
