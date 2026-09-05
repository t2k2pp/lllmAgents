import { afterEach, describe, expect, it, vi } from "vitest";
import { INPUT_CANCELLED_SIGNAL, InteractiveInput } from "../../src/cli/interactive-input.js";
import { screen } from "../../src/cli/screen-manager.js";

describe("InteractiveInput lifecycle", () => {
  const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  afterEach(() => {
    vi.restoreAllMocks();
    if (stdinIsTTY) Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  });

  it("処理完了Abortでinline composerを消してから通常promptへ所有権を返す", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const writes: string[] = [];
    const releases: string[] = [];
    vi.spyOn(screen, "isAlternate").mockReturnValue(false);
    vi.spyOn(screen, "writeLive").mockImplementation((text) => writes.push(text));
    vi.spyOn(screen, "acquireLive").mockImplementation(() => () => releases.push("release"));

    const controller = new AbortController();
    const pending = new InteractiveInput().question("[処理中・追加入力] [autorun] > ", {
      signal: controller.signal,
      ownerName: "processing-input",
      pinned: true,
    });

    controller.abort();

    expect(await pending).toBe(INPUT_CANCELLED_SIGNAL);
    expect(releases).toEqual(["release"]);
    expect(writes.join("")).toContain("\r\x1b[2K\r");
  });
});
