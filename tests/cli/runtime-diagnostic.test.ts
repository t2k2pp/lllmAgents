import { describe, expect, it, vi } from "vitest";
import type { ScreenManager } from "../../src/cli/screen-manager.js";
import { writeRuntimeError } from "../../src/cli/runtime-diagnostic.js";

function fakeScreen(alternate: boolean): { screen: ScreenManager; committed: string[] } {
  const committed: string[] = [];
  const screen = {
    isAlternate: () => alternate,
    write: (text: string) => committed.push(text),
  } as unknown as ScreenManager;
  return { screen, committed };
}

describe("writeRuntimeError", () => {
  it("Alternate Screen中はエラーを確定scrollbackへ残す", () => {
    const { screen, committed } = fakeScreen(true);
    const stderr = vi.fn();

    writeRuntimeError("HTTP 400: Unsupported parameter", screen, stderr);

    expect(committed).toEqual(["HTTP 400: Unsupported parameter\n"]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("classic streamではstderr分離を維持する", () => {
    const { screen, committed } = fakeScreen(false);
    const stderr = vi.fn();

    writeRuntimeError("connection failed", screen, stderr);

    expect(committed).toEqual([]);
    expect(stderr).toHaveBeenCalledWith("connection failed\n");
  });
});
