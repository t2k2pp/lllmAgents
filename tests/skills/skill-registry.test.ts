import { describe, it, expect, beforeEach } from "vitest";
import { SkillRegistry, type SkillDefinition } from "../../src/skills/skill-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "test-skill",
    description: "A test skill",
    trigger: "/test",
    content: "Test skill content",
    filePath: "/path/to/test-skill.md",
    builtIn: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillRegistry", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  // -----------------------------------------------------------------------
  // register
  // -----------------------------------------------------------------------

  describe("register", () => {
    it("should register a skill by name", () => {
      const skill = createSkill({ name: "commit", trigger: "/commit" });
      registry.register(skill);

      expect(registry.get("commit")).toBeDefined();
      expect(registry.get("commit")!.name).toBe("commit");
    });

    it("should also register by trigger (without slash)", () => {
      const skill = createSkill({ name: "commit-skill", trigger: "/commit" });
      registry.register(skill);

      // Should be retrievable by the trigger name without slash
      expect(registry.get("commit")).toBeDefined();
      expect(registry.get("commit")!.name).toBe("commit-skill");
    });

    it("should overwrite existing skill with same name", () => {
      const skill1 = createSkill({ name: "tdd", description: "Original" });
      const skill2 = createSkill({ name: "tdd", description: "Updated" });

      registry.register(skill1);
      registry.register(skill2);

      expect(registry.get("tdd")!.description).toBe("Updated");
    });

    it("should handle trigger without leading slash", () => {
      const skill = createSkill({ name: "custom", trigger: "custom-trigger" });
      registry.register(skill);

      // Should be retrievable by name
      expect(registry.get("custom")).toBeDefined();
      // Trigger doesn't start with /, so no secondary registration
    });
  });

  // -----------------------------------------------------------------------
  // get by name
  // -----------------------------------------------------------------------

  describe("get by name", () => {
    it("should return skill by exact name", () => {
      const skill = createSkill({ name: "planner" });
      registry.register(skill);

      const result = registry.get("planner");
      expect(result).toBeDefined();
      expect(result!.name).toBe("planner");
    });

    it("should return undefined for unregistered name", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // get by trigger
  // -----------------------------------------------------------------------

  describe("get by trigger", () => {
    it("should return skill by trigger with leading slash", () => {
      const skill = createSkill({ name: "commit-workflow", trigger: "/commit" });
      registry.register(skill);

      // get("/commit") should try without "/" -> "commit"
      const result = registry.get("/commit");
      expect(result).toBeDefined();
      expect(result!.name).toBe("commit-workflow");
    });

    it("should return skill by trigger without leading slash", () => {
      const skill = createSkill({ name: "commit-workflow", trigger: "/commit" });
      registry.register(skill);

      const result = registry.get("commit");
      expect(result).toBeDefined();
      expect(result!.name).toBe("commit-workflow");
    });

    it("should return undefined for unmatched trigger", () => {
      const skill = createSkill({ name: "tdd", trigger: "/tdd" });
      registry.register(skill);

      expect(registry.get("/plan")).toBeUndefined();
      expect(registry.get("plan")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // list
  // -----------------------------------------------------------------------

  describe("list", () => {
    it("should return empty array when no skills registered", () => {
      expect(registry.list()).toEqual([]);
    });

    it("should return all registered skills", () => {
      registry.register(createSkill({ name: "skill-a", trigger: "/a" }));
      registry.register(createSkill({ name: "skill-b", trigger: "/b" }));
      registry.register(createSkill({ name: "skill-c", trigger: "/c" }));

      const skills = registry.list();
      expect(skills.length).toBe(3);

      const names = skills.map((s) => s.name);
      expect(names).toContain("skill-a");
      expect(names).toContain("skill-b");
      expect(names).toContain("skill-c");
    });

    it("should deduplicate skills stored under name and trigger", () => {
      // A skill with trigger "/commit" is stored under both "commit-workflow" and "commit"
      registry.register(createSkill({ name: "commit-workflow", trigger: "/commit" }));

      const skills = registry.list();
      // Should only appear once despite being stored twice in the internal map
      expect(skills.length).toBe(1);
      expect(skills[0].name).toBe("commit-workflow");
    });

    it("should deduplicate correctly with multiple skills", () => {
      registry.register(createSkill({ name: "skill-a", trigger: "/a" }));
      registry.register(createSkill({ name: "skill-b", trigger: "/b" }));

      const skills = registry.list();
      expect(skills.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // getNames
  // -----------------------------------------------------------------------

  describe("getNames", () => {
    it("should return empty array when no skills registered", () => {
      expect(registry.getNames()).toEqual([]);
    });

    it("should return all skill names", () => {
      registry.register(createSkill({ name: "tdd", trigger: "/tdd" }));
      registry.register(createSkill({ name: "plan", trigger: "/plan" }));

      const names = registry.getNames();
      expect(names).toContain("tdd");
      expect(names).toContain("plan");
      expect(names.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // getTriggers
  // -----------------------------------------------------------------------

  describe("getTriggers", () => {
    it("should return empty array when no skills registered", () => {
      expect(registry.getTriggers()).toEqual([]);
    });

    it("should return all triggers", () => {
      registry.register(createSkill({ name: "tdd", trigger: "/tdd" }));
      registry.register(createSkill({ name: "plan", trigger: "/plan" }));

      const triggers = registry.getTriggers();
      expect(triggers).toContain("/tdd");
      expect(triggers).toContain("/plan");
      expect(triggers.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("should handle skill with all fields populated", () => {
      const skill: SkillDefinition = {
        name: "full-skill",
        description: "A fully populated skill",
        trigger: "/full",
        content: "# Full Skill\n\nDo everything.",
        filePath: "/skills/full-skill.md",
        builtIn: true,
      };

      registry.register(skill);

      const retrieved = registry.get("full-skill");
      expect(retrieved).toEqual(skill);
    });

    it("should distinguish between different skills with similar names", () => {
      registry.register(createSkill({ name: "test", trigger: "/test" }));
      registry.register(createSkill({ name: "test-e2e", trigger: "/test-e2e" }));

      expect(registry.get("test")!.name).toBe("test");
      expect(registry.get("test-e2e")!.name).toBe("test-e2e");
    });
  });
});
