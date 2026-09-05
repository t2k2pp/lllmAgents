import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "../../src/cli/screen-manager.js";
import { info, setLogLevel } from "../../src/utils/logger.js";

describe("logger", () => {
  afterEach(() => {
    setLogLevel("info");
    vi.restoreAllMocks();
  });

  it("INFOログをlive composerと排他制御できる診断経路へ渡す", () => {
    const diagnostic = vi.spyOn(screen, "writeDiagnostic").mockImplementation(() => {});
    setLogLevel("info");

    info("[strategy] B5(応答完了)", { usage: 25 });

    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic.mock.calls[0]?.[0]).toContain("[INFO] [strategy] B5(応答完了) { usage: 25 }");
  });
});
