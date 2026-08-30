import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ComputerMouseButton, ComputerWindow, DesktopDriver } from "./types.js";
import { runCommand, type CommandRunner } from "./process.js";

const X11_KEY_NAMES: Record<string, string> = {
  CTRL: "ctrl",
  ALT: "alt",
  SHIFT: "shift",
  META: "super",
  ENTER: "Return",
  TAB: "Tab",
  ESCAPE: "Escape",
  BACKSPACE: "BackSpace",
  DELETE: "Delete",
  UP: "Up",
  DOWN: "Down",
  LEFT: "Left",
  RIGHT: "Right",
  HOME: "Home",
  END: "End",
  PAGEUP: "Prior",
  PAGEDOWN: "Next",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `F${index + 1}`])),
};

function parseGeometry(output: string): Pick<ComputerWindow, "x" | "y" | "width" | "height"> {
  const values = Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => line.split("=", 2))
      .filter((parts) => parts.length === 2),
  );
  const result = {
    x: Number(values.X),
    y: Number(values.Y),
    width: Number(values.WIDTH),
    height: Number(values.HEIGHT),
  };
  if (Object.values(result).some((value) => !Number.isFinite(value)) || result.width <= 0 || result.height <= 0) {
    throw new Error(`xdotool returned invalid geometry: ${output}`);
  }
  return result;
}

export class LinuxX11DesktopDriver implements DesktopDriver {
  readonly platform = "linux-x11" as const;

  constructor(private readonly runner: CommandRunner = runCommand) {}

  private async target(windowId: string): Promise<ComputerWindow> {
    if (!/^\d+$/.test(windowId)) throw new Error("invalid X11 window_id; call computer_windows again");
    let title: string;
    let geometry: string;
    try {
      [title, geometry] = await Promise.all([
        this.runner("xdotool", ["getwindowname", windowId]),
        this.runner("xdotool", ["getwindowgeometry", "--shell", windowId]),
      ]);
    } catch (error) {
      throw new Error(`target X11 window no longer exists; call computer_windows again (${error})`);
    }
    return { id: windowId, app: "X11", title: title.trim(), ...parseGeometry(geometry) };
  }

  async listWindows(): Promise<ComputerWindow[]> {
    let output: string;
    try {
      output = await this.runner("xdotool", ["search", "--onlyvisible", "--name", "."]);
    } catch (error) {
      throw new Error(`No visible X11 windows were found (${error})`);
    }
    const ids = [...new Set(output.split(/\s+/).filter((id) => /^\d+$/.test(id)))];
    const windows: ComputerWindow[] = [];
    for (const id of ids) {
      try {
        windows.push(await this.target(id));
      } catch {
        // Window closed between enumeration and detail lookup; omit that stale entry.
      }
    }
    return windows;
  }

  private async activate(windowId: string): Promise<ComputerWindow> {
    const target = await this.target(windowId);
    await this.runner("xdotool", ["windowactivate", "--sync", windowId]);
    return target;
  }

  async screenshot(windowId: string, outputPath: string): Promise<ComputerWindow> {
    const target = await this.target(windowId);
    await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await this.runner("import", ["-window", windowId, `png:${path.resolve(outputPath)}`]);
    return target;
  }

  async click(
    windowId: string,
    x: number,
    y: number,
    button: ComputerMouseButton,
    clicks: number,
  ): Promise<ComputerWindow> {
    const target = await this.activate(windowId);
    if (x < 0 || y < 0 || x >= target.width || y >= target.height)
      throw new Error("coordinates are outside the selected window");
    const buttonNumber = button === "right" ? "3" : button === "middle" ? "2" : "1";
    await this.runner("xdotool", [
      "mousemove",
      "--window",
      windowId,
      String(x),
      String(y),
      "click",
      "--repeat",
      String(clicks),
      buttonNumber,
    ]);
    return target;
  }

  async typeText(windowId: string, text: string): Promise<ComputerWindow> {
    const target = await this.activate(windowId);
    await this.runner("xdotool", ["type", "--window", windowId, "--clearmodifiers", "--delay", "0", "--", text]);
    return target;
  }

  async key(windowId: string, keys: string[]): Promise<ComputerWindow> {
    const target = await this.activate(windowId);
    const chord = keys.map((key) => X11_KEY_NAMES[key] ?? key.toLowerCase()).join("+");
    await this.runner("xdotool", ["key", "--window", windowId, "--clearmodifiers", chord]);
    return target;
  }

  async scroll(windowId: string, x: number, y: number, deltaY: number): Promise<ComputerWindow> {
    const target = await this.activate(windowId);
    if (x < 0 || y < 0 || x >= target.width || y >= target.height)
      throw new Error("coordinates are outside the selected window");
    const button = deltaY > 0 ? "4" : "5";
    await this.runner("xdotool", [
      "mousemove",
      "--window",
      windowId,
      String(x),
      String(y),
      "click",
      "--repeat",
      String(Math.abs(deltaY)),
      button,
    ]);
    return target;
  }
}
