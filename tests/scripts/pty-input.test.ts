import { describe, expect, it } from "vitest";
import { submitPtyLine } from "../../scripts/pty-input.js";

describe("PTY smoke input", () => {
  it("コマンドをLFではなく端末のEnterであるCRで確定する", () => {
    expect(submitPtyLine("/quit")).toBe("/quit\r");
    expect(submitPtyLine("/quit")).not.toContain("\n");
  });
});
