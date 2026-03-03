import { describe, it, expect, beforeEach } from "vitest";
import { ContextModeManager, type ContextMode } from "../../src/context/context-mode.js";

describe("ContextModeManager", () => {
  let manager: ContextModeManager;

  beforeEach(() => {
    manager = new ContextModeManager();
  });

  // -----------------------------------------------------------------------
  // Default mode
  // -----------------------------------------------------------------------

  describe("default mode", () => {
    it("should default to 'dev' mode", () => {
      expect(manager.currentMode).toBe("dev");
    });
  });

  // -----------------------------------------------------------------------
  // switchMode
  // -----------------------------------------------------------------------

  describe("switchMode", () => {
    it("should switch to 'review' mode", () => {
      manager.switchMode("review");
      expect(manager.currentMode).toBe("review");
    });

    it("should switch to 'research' mode", () => {
      manager.switchMode("research");
      expect(manager.currentMode).toBe("research");
    });

    it("should switch back to 'dev' mode", () => {
      manager.switchMode("review");
      manager.switchMode("dev");
      expect(manager.currentMode).toBe("dev");
    });

    it("should support multiple mode switches", () => {
      manager.switchMode("review");
      expect(manager.currentMode).toBe("review");

      manager.switchMode("research");
      expect(manager.currentMode).toBe("research");

      manager.switchMode("dev");
      expect(manager.currentMode).toBe("dev");
    });
  });

  // -----------------------------------------------------------------------
  // getPromptSection
  // -----------------------------------------------------------------------

  describe("getPromptSection", () => {
    it("should return dev mode prompt section by default", () => {
      const section = manager.getPromptSection();

      expect(section).toContain("Development");
      expect(section).toContain("Work -> Correct -> Clean");
      expect(section).toContain("Write code first, test after, commit atomically");
      expect(section).toContain("file_write");
      expect(section).toContain("file_edit");
      expect(section).toContain("bash");
      expect(section).toContain("task");
    });

    it("should return review mode prompt section", () => {
      manager.switchMode("review");
      const section = manager.getPromptSection();

      expect(section).toContain("Code Review");
      expect(section).toContain("Critical > High > Medium > Low");
      expect(section).toContain("Thorough analysis");
      expect(section).toContain("file_read");
      expect(section).toContain("grep");
      expect(section).toContain("glob");
    });

    it("should return research mode prompt section", () => {
      manager.switchMode("research");
      const section = manager.getPromptSection();

      expect(section).toContain("Research");
      expect(section).toContain("Understand -> Verify -> Document");
      expect(section).toContain("Explore and learn");
      expect(section).toContain("web_fetch");
      expect(section).toContain("web_search");
    });

    it("should include Context Mode header", () => {
      const section = manager.getPromptSection();
      expect(section).toContain("# Context Mode:");
    });

    it("should include Priority label", () => {
      const section = manager.getPromptSection();
      expect(section).toContain("- Priority:");
    });

    it("should include Behavior label", () => {
      const section = manager.getPromptSection();
      expect(section).toContain("- Behavior:");
    });

    it("should include Preferred tools label", () => {
      const section = manager.getPromptSection();
      expect(section).toContain("- Preferred tools:");
    });
  });

  // -----------------------------------------------------------------------
  // getModeInfo
  // -----------------------------------------------------------------------

  describe("getModeInfo", () => {
    it("should return dev mode info by default", () => {
      const info = manager.getModeInfo();

      expect(info.name).toBe("Development");
      expect(info.description).toBe("Active development mode");
      expect(info.priority).toBe("Work -> Correct -> Clean");
    });

    it("should return review mode info", () => {
      manager.switchMode("review");
      const info = manager.getModeInfo();

      expect(info.name).toBe("Code Review");
      expect(info.description).toBe("Code review mode");
      expect(info.priority).toBe("Critical > High > Medium > Low");
    });

    it("should return research mode info", () => {
      manager.switchMode("research");
      const info = manager.getModeInfo();

      expect(info.name).toBe("Research");
      expect(info.description).toBe("Research and exploration mode");
      expect(info.priority).toBe("Understand -> Verify -> Document");
    });

    it("should return an object with exactly name, description, and priority", () => {
      const info = manager.getModeInfo();
      const keys = Object.keys(info);

      expect(keys).toContain("name");
      expect(keys).toContain("description");
      expect(keys).toContain("priority");
      expect(keys.length).toBe(3);
    });

    it("should reflect mode changes", () => {
      expect(manager.getModeInfo().name).toBe("Development");

      manager.switchMode("review");
      expect(manager.getModeInfo().name).toBe("Code Review");

      manager.switchMode("research");
      expect(manager.getModeInfo().name).toBe("Research");
    });
  });
});
