import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RuleLoader, type Rule } from "../../src/rules/rule-loader.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// We need to mock fs so we can control which directories/files exist
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockDir {
  exists: boolean;
  files?: { name: string; content: string }[];
}

/**
 * Set up mock filesystem with a map of directory paths to their contents.
 * Directories not in the map return existsSync = false.
 */
function setupMockDirs(dirs: Record<string, MockDir>) {
  mockExistsSync.mockImplementation((p: fs.PathLike) => {
    const dirPath = String(p);
    if (dirPath in dirs) return dirs[dirPath].exists;
    return false;
  });

  mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
    const dirPath = String(p);
    if (dirPath in dirs && dirs[dirPath].exists && dirs[dirPath].files) {
      return dirs[dirPath].files!.map((f) => f.name) as any;
    }
    return [] as any;
  });

  mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
    const filePath = String(p);
    for (const [dirPath, dirConfig] of Object.entries(dirs)) {
      if (!dirConfig.files) continue;
      for (const file of dirConfig.files) {
        const fullPath = path.join(dirPath, file.name);
        // Normalize to handle path separator differences
        if (filePath === fullPath || filePath.replace(/\\/g, "/") === fullPath.replace(/\\/g, "/")) {
          return file.content;
        }
      }
    }
    throw new Error(`ENOENT: no such file: ${p}`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RuleLoader", () => {
  let loader: RuleLoader;

  beforeEach(() => {
    loader = new RuleLoader();
    vi.clearAllMocks();
  });

  describe("loadAllRules", () => {
    it("should return empty array when no rule directories exist", () => {
      mockExistsSync.mockReturnValue(false);

      const rules = loader.loadAllRules();

      expect(rules).toEqual([]);
    });

    it("should load .md files from builtin directory", () => {
      // The builtin directory path is derived from import.meta.url
      // We set up a catch-all that returns rules for any directory that "exists"
      const builtinContent = "Always follow coding standards.";

      mockExistsSync.mockReturnValue(false);
      // We need to match only the builtin dir check and allow it
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.includes("builtin")) return true;
        return false;
      });
      mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        const s = String(p);
        if (s.includes("builtin")) return ["coding-style.md"] as any;
        return [] as any;
      });
      mockReadFileSync.mockImplementation((_p: fs.PathOrFileDescriptor) => {
        return builtinContent;
      });

      const rules = loader.loadAllRules();

      expect(rules.length).toBe(1);
      expect(rules[0].name).toBe("coding-style");
      expect(rules[0].content).toBe(builtinContent);
      expect(rules[0].source).toBe("builtin");
    });

    it("should load rules from user-global directory", () => {
      const userRulesDir = path.join(os.homedir(), ".localllm", "rules");
      const ruleContent = "Always write tests.";

      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === userRulesDir;
      });
      mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === userRulesDir) return ["testing.md"] as any;
        return [] as any;
      });
      mockReadFileSync.mockReturnValue(ruleContent);

      const rules = loader.loadAllRules();

      const userRule = rules.find((r) => r.source === "user");
      expect(userRule).toBeDefined();
      expect(userRule!.name).toBe("testing");
      expect(userRule!.content).toBe(ruleContent);
    });

    it("should load rules from project .claude/rules/ directory", () => {
      const projectRulesDir = path.join(process.cwd(), ".claude", "rules");
      const ruleContent = "Use TypeScript strict mode.";

      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === projectRulesDir;
      });
      mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === projectRulesDir) return ["typescript.md"] as any;
        return [] as any;
      });
      mockReadFileSync.mockReturnValue(ruleContent);

      const rules = loader.loadAllRules();

      const projectRule = rules.find((r) => r.source === "project");
      expect(projectRule).toBeDefined();
      expect(projectRule!.name).toBe("typescript");
    });

    it("should load rules from project .localllm/rules/ directory", () => {
      const localllmRulesDir = path.join(process.cwd(), ".localllm", "rules");
      const ruleContent = "Use ESM modules.";

      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === localllmRulesDir;
      });
      mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === localllmRulesDir) return ["esm.md"] as any;
        return [] as any;
      });
      mockReadFileSync.mockReturnValue(ruleContent);

      const rules = loader.loadAllRules();

      const projectRule = rules.find((r) => r.source === "project");
      expect(projectRule).toBeDefined();
      expect(projectRule!.name).toBe("esm");
    });

    it("should only load .md files, ignoring other extensions", () => {
      const dir = path.join(process.cwd(), ".claude", "rules");

      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === dir;
      });
      mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === dir) return ["rule.md", "notes.txt", "config.json", "readme.md"] as any;
        return [] as any;
      });
      mockReadFileSync.mockReturnValue("rule content");

      const rules = loader.loadAllRules();

      const projectRules = rules.filter((r) => r.source === "project");
      expect(projectRules.length).toBe(2); // rule.md and readme.md
    });

    it("should skip empty files", () => {
      const dir = path.join(process.cwd(), ".claude", "rules");

      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === dir;
      });
      mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === dir) return ["empty.md", "valid.md"] as any;
        return [] as any;
      });
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p).includes("empty.md")) return "   \n  \n  ";
        return "valid rule content";
      });

      const rules = loader.loadAllRules();

      const projectRules = rules.filter((r) => r.source === "project");
      expect(projectRules.length).toBe(1);
      expect(projectRules[0].name).toBe("valid");
    });

    it("should handle unreadable files gracefully", () => {
      const dir = path.join(process.cwd(), ".claude", "rules");

      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === dir;
      });
      mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === dir) return ["broken.md", "ok.md"] as any;
        return [] as any;
      });
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p).includes("broken.md")) throw new Error("EACCES");
        return "ok content";
      });

      const rules = loader.loadAllRules();

      const projectRules = rules.filter((r) => r.source === "project");
      expect(projectRules.length).toBe(1);
      expect(projectRules[0].name).toBe("ok");
    });

    it("should strip .md extension for rule name", () => {
      const dir = path.join(process.cwd(), ".claude", "rules");

      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === dir;
      });
      mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === dir) return ["my-coding-rule.md"] as any;
        return [] as any;
      });
      mockReadFileSync.mockReturnValue("rule body");

      const rules = loader.loadAllRules();

      const projectRules = rules.filter((r) => r.source === "project");
      expect(projectRules[0].name).toBe("my-coding-rule");
    });
  });

  describe("formatForSystemPrompt", () => {
    it("should return empty string when no rules exist", () => {
      mockExistsSync.mockReturnValue(false);

      const output = loader.formatForSystemPrompt();

      expect(output).toBe("");
    });

    it("should format rules with header section", () => {
      const dir = path.join(process.cwd(), ".claude", "rules");

      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === dir;
      });
      mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === dir) return ["security.md"] as any;
        return [] as any;
      });
      mockReadFileSync.mockReturnValue("Never expose API keys.");

      const output = loader.formatForSystemPrompt();

      expect(output).toContain("# ルール");
      expect(output).toContain("以下のルールに常に従ってください");
      expect(output).toContain("Never expose API keys.");
    });

    it("should include content from multiple rules", () => {
      const dir = path.join(process.cwd(), ".claude", "rules");

      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === dir;
      });
      mockReaddirSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === dir) return ["rule-a.md", "rule-b.md"] as any;
        return [] as any;
      });
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p).includes("rule-a")) return "Rule A content";
        return "Rule B content";
      });

      const output = loader.formatForSystemPrompt();

      expect(output).toContain("Rule A content");
      expect(output).toContain("Rule B content");
    });
  });
});
