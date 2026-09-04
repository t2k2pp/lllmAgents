import { describe, expect, it } from "vitest";
import { currentInteractionMode, nextInteractionMode } from "../../src/cli/interaction-mode.js";
import { isModeCycleKey } from "../../src/cli/interactive-input.js";

describe("Shift+Tab interaction mode", () => {
  it("default → autorun → plan → default の順で循環する", () => {
    const first = nextInteractionMode("default");
    const second = nextInteractionMode(first);
    const third = nextInteractionMode(second);
    expect([first, second, third]).toEqual(["autorun", "plan", "default"]);
  });

  it("planをautorunより優先して現在modeを判定する", () => {
    expect(currentInteractionMode(true, true)).toBe("plan");
    expect(currentInteractionMode(false, true)).toBe("autorun");
    expect(currentInteractionMode(false, false)).toBe("default");
  });

  it("readlineのShift+TabとCSI Zをmode切替keyとして認識し、通常Tabと分離する", () => {
    expect(isModeCycleKey({ name: "tab", shift: true, sequence: "\x1b[Z" })).toBe(true);
    expect(isModeCycleKey({ name: "tab", sequence: "\t" })).toBe(false);
  });
});
