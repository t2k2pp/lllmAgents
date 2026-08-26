import { describe, expect, it } from "vitest";
import { resolveStartupMode } from "../../src/cli/startup-mode.js";

describe("resolveStartupMode", () => {
  it("keeps every customization surface enabled by default", () => {
    expect(resolveStartupMode([])).toEqual({
      safeMode: false,
      customizations: {
        plugins: true,
        skills: true,
        hooks: true,
        mcp: true,
        projectInstructions: true,
        memory: true,
        customAgents: true,
        customRules: true,
      },
    });
  });

  it("disables every customization surface with --safe-mode", () => {
    expect(resolveStartupMode(["--safe-mode", "--plugin-dir", "./broken-plugin"])).toEqual({
      safeMode: true,
      customizations: {
        plugins: false,
        skills: false,
        hooks: false,
        mcp: false,
        projectInstructions: false,
        memory: false,
        customAgents: false,
        customRules: false,
      },
    });
  });
});
