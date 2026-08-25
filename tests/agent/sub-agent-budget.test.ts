import { describe, expect, it } from "vitest";
import { normalizeSubAgentMaxTurns } from "../../src/agent/sub-agent.js";

describe("sub-agent delegation turn budget", () => {
  it.each([
    [undefined, 30],
    [Number.NaN, 30],
    [0, 1],
    [1, 1],
    [7.9, 7],
    [30, 30],
    [999, 30],
  ])("%s を厳格な1..30上限へ正規化する", (input, expected) => {
    expect(normalizeSubAgentMaxTurns(input)).toBe(expected);
  });
});
