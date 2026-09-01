import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "../../src/cli/screen-manager.js";
import { createSpinner } from "../../src/utils/spinner.js";

describe("createSpinner: alternate screen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Oraを起動せずScreenManagerで状態更新と確定行を描画する", () => {
    vi.spyOn(screen, "isAlternate").mockReturnValue(true);
    vi.spyOn(screen, "isExclusive").mockReturnValue(false);
    const update = vi.spyOn(screen, "updateTransientStatus").mockImplementation(() => {});
    const clear = vi.spyOn(screen, "clearTransientStatus").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const spinner = createSpinner("処理中").start();
    expect(spinner.isSpinning).toBe(true);
    expect(update).toHaveBeenLastCalledWith("処理中");

    spinner.text = "更新中";
    expect(update).toHaveBeenLastCalledWith("更新中");

    expect(spinner.succeed("完了")).toBe(spinner);
    expect(spinner.isSpinning).toBe(false);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("✔ 完了");
  });

  it("排他prompt中は一過性statusを描画しない", () => {
    vi.spyOn(screen, "isAlternate").mockReturnValue(true);
    vi.spyOn(screen, "isExclusive").mockReturnValue(true);
    const update = vi.spyOn(screen, "updateTransientStatus").mockImplementation(() => {});

    const spinner = createSpinner("待機").start();

    expect(spinner.isSpinning).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
