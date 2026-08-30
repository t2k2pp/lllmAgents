import { describe, expect, it, vi } from "vitest";
import type { ComputerWindow, DesktopDriver } from "../../src/computer-use/types.js";
import { createComputerTools } from "../../src/tools/definitions/computer.js";

const windowInfo: ComputerWindow = {
  id: "w-1",
  app: "Test App",
  title: "Dedicated Test Window",
  x: 10,
  y: 20,
  width: 640,
  height: 480,
};

function fakeDriver(): DesktopDriver {
  return {
    platform: "windows",
    listWindows: vi.fn(async () => [windowInfo]),
    screenshot: vi.fn(async () => windowInfo),
    click: vi.fn(async () => windowInfo),
    typeText: vi.fn(async () => windowInfo),
    key: vi.fn(async () => windowInfo),
    scroll: vi.fn(async () => windowInfo),
  };
}

function tool(driver: DesktopDriver, name: string) {
  const found = createComputerTools(driver).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing test tool: ${name}`);
  return found;
}

describe("computer tools", () => {
  it("window列挙はIDとboundsを返す", async () => {
    const [windows] = createComputerTools(fakeDriver());
    const result = await windows.execute({}, { ancestors: new Set(), source: "cli" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("w-1");
    expect(result.output).toContain("640x480");
    expect(result.output).toContain("UNTRUSTED");
  });

  it("screenshotはtarget window IDと保存先だけをdriverへ渡す", async () => {
    const driver = fakeDriver();
    const screenshot = tool(driver, "computer_screenshot");
    const result = await screenshot.execute(
      { window_id: "w-1", save_path: "C:/tmp/target.png" },
      { ancestors: new Set(), source: "cli" },
    );
    expect(result.success).toBe(true);
    expect(driver.screenshot).toHaveBeenCalledWith("w-1", "C:/tmp/target.png");
    expect(result.output).toContain("vision_analyze");
    expect(result.output).toContain("untrusted data");
  });

  it("remote surfaceからhandlerを直接呼んでも拒否する", async () => {
    const click = tool(fakeDriver(), "computer_click");
    const result = await click.execute(
      { window_id: "w-1", x: 10, y: 10, button: "left", clicks: 1 },
      { ancestors: new Set(), source: "slack" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("CLI");
  });

  it("click座標をwindow bounds内へ制限する", async () => {
    const driver = fakeDriver();
    const click = tool(driver, "computer_click");
    const result = await click.execute(
      { window_id: "w-1", x: -1, y: 10, button: "left", clicks: 1 },
      { ancestors: new Set(), source: "cli" },
    );
    expect(result.success).toBe(false);
    expect(driver.click).not.toHaveBeenCalled();
  });

  it("key chordはmodifierを先頭、通常keyを末尾に限定する", async () => {
    const driver = fakeDriver();
    const key = tool(driver, "computer_key");
    const result = await key.execute(
      { window_id: "w-1", keys: ["A", "CTRL"] },
      { ancestors: new Set(), source: "cli" },
    );
    expect(result.success).toBe(false);
    expect(driver.key).not.toHaveBeenCalled();
  });

  it("macOSでは未実装wheelをtoolとして公開しない", () => {
    const driver = { ...fakeDriver(), platform: "macos" as const };
    expect(createComputerTools(driver).map((candidate) => candidate.name)).not.toContain("computer_scroll");
    expect(createComputerTools(fakeDriver()).map((candidate) => candidate.name)).toContain("computer_scroll");
  });
});
