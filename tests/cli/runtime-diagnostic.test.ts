import { describe, expect, it, vi } from "vitest";
import { ScreenManagerImpl, type ScreenManager } from "../../src/cli/screen-manager.js";
import { writeRuntimeError } from "../../src/cli/runtime-diagnostic.js";

function fakeScreen(alternate: boolean): { screen: ScreenManager; committed: string[] } {
  const committed: string[] = [];
  const screen = {
    isAlternate: () => alternate,
    write: (text: string) => committed.push(text),
    writeDiagnostic: (text: string, stderr?: (text: string) => void) => {
      if (alternate) committed.push(text);
      else stderr?.(text);
    },
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

  it("classic streamのsoft owner表示中はstderrをcomposerの消去と再描画で挟む", () => {
    const stdout: string[] = [];
    const order: string[] = [];
    const screen = new ScreenManagerImpl({ sink: (text) => stdout.push(text), stdin: null });
    const release = screen.acquireLive({
      name: "processing-input",
      pinned: true,
      clear: () => order.push("clear"),
      redraw: () => order.push("redraw"),
    });
    const stderr = vi.fn((text: string) => order.push(`stderr:${text}`));

    writeRuntimeError("[INFO] [strategy] complete", screen, stderr);

    expect(order).toEqual(["clear", "stderr:[INFO] [strategy] complete\n", "redraw"]);
    expect(stdout).toEqual([]);
    release();
  });
});
