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

  getByPrefix(input: string): { skill: SkillDefinition; remainingArgs: string } | undefined {
    let bestMatch: SkillDefinition | undefined = undefined;
    
    // skillsマップには name と trigger(スラッシュなし) が両方入っているため、
    // 重複を弾くために values() からユニークなskillを取り出して検査する
    const uniqueSkills = this.list();
    
    for (const skill of uniqueSkills) {
      // トリガー (例: /chunkbase) で前方一致するか確認
      if (input.startsWith(skill.trigger)) {
        if (!bestMatch || skill.trigger.length > bestMatch.trigger.length) {
          bestMatch = skill;
        }
      }
    }
    
    if (bestMatch) {
      const remainingArgs = input.slice(bestMatch.trigger.length).trim();
      return { skill: bestMatch, remainingArgs };
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
