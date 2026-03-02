export interface SkillDefinition {
  name: string;
  description: string;
  trigger: string;  // e.g., "/commit"
  content: string;  // The full skill prompt/instructions
  filePath: string;
  builtIn: boolean;
}

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
    // Also register by trigger (without /)
    if (skill.trigger.startsWith("/")) {
      this.skills.set(skill.trigger.slice(1), skill);
    }
  }

  get(nameOrTrigger: string): SkillDefinition | undefined {
    // Try exact match
    const direct = this.skills.get(nameOrTrigger);
    if (direct) return direct;

    // Try without leading /
    if (nameOrTrigger.startsWith("/")) {
      return this.skills.get(nameOrTrigger.slice(1));
    }

    return undefined;
  }

  list(): SkillDefinition[] {
    // Deduplicate (skills are stored by name and trigger)
    const seen = new Set<string>();
    const result: SkillDefinition[] = [];
    for (const skill of this.skills.values()) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        result.push(skill);
      }
    }
    return result;
  }

  getNames(): string[] {
    return this.list().map((s) => s.name);
  }

  getTriggers(): string[] {
    return this.list().map((s) => s.trigger);
  }
}
