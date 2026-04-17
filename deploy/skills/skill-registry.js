export class SkillRegistry {
    skills = new Map();
    register(skill) {
        this.skills.set(skill.name, skill);
        // Also register by trigger (without /)
        if (skill.trigger.startsWith("/")) {
            this.skills.set(skill.trigger.slice(1), skill);
        }
    }
    get(nameOrTrigger) {
        // Try exact match
        const direct = this.skills.get(nameOrTrigger);
        if (direct)
            return direct;
        // Try without leading /
        if (nameOrTrigger.startsWith("/")) {
            return this.skills.get(nameOrTrigger.slice(1));
        }
        return undefined;
    }
    getByPrefix(input) {
        let bestMatch = undefined;
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
    list() {
        // Deduplicate (skills are stored by name and trigger)
        const seen = new Set();
        const result = [];
        for (const skill of this.skills.values()) {
            if (!seen.has(skill.name)) {
                seen.add(skill.name);
                result.push(skill);
            }
        }
        return result;
    }
    getNames() {
        return this.list().map((s) => s.name);
    }
    getTriggers() {
        return this.list().map((s) => s.trigger);
    }
}
//# sourceMappingURL=skill-registry.js.map