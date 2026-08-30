import { describe, expect, it } from "vitest";
import { detectComputerUseCapability } from "../../src/computer-use/capability.js";

const exists = (available: string[]) => (command: string) => available.includes(command);

describe("detectComputerUseCapability", () => {
  it("明示opt-inが無ければdependencyがあっても無効", () => {
    const result = detectComputerUseCapability({ requested: false, platform: "win32", commandExists: exists([]) });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("explicit opt-in");
  });

  it("WindowsはPowerShellがあればready", () => {
    const result = detectComputerUseCapability({
      requested: true,
      platform: "win32",
      commandExists: exists(["powershell.exe"]),
    });
    expect(result).toMatchObject({ ready: true, platform: "windows" });
  });

  it("macOSはosascriptとscreencaptureを両方要求する", () => {
    const result = detectComputerUseCapability({
      requested: true,
      platform: "darwin",
      commandExists: exists(["/usr/bin/osascript"]),
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("screencapture");
  });

  it("Linux Waylandへ黙って縮退しない", () => {
    const result = detectComputerUseCapability({
      requested: true,
      platform: "linux",
      env: { DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" },
      commandExists: exists(["xdotool", "import"]),
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("Wayland");
  });

  it("Linux X11はDISPLAY、xdotool、importを要求する", () => {
    const result = detectComputerUseCapability({
      requested: true,
      platform: "linux",
      env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
      commandExists: exists(["xdotool", "import"]),
    });
    expect(result).toMatchObject({ ready: true, platform: "linux-x11" });
  });
});
