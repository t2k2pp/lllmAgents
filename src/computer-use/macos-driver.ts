import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ComputerMouseButton, ComputerWindow, DesktopDriver } from "./types.js";
import { runCommand, type CommandRunner } from "./process.js";

const LIST_JXA = `
function run() {
  const systemEvents = Application("System Events");
  const result = [];
  for (const process of systemEvents.applicationProcesses()) {
    try {
      if (!process.visible()) continue;
      const app = String(process.name());
      const windows = process.windows();
      for (let index = 0; index < windows.length; index++) {
        const window = windows[index];
        const position = window.position();
        const size = window.size();
        if (!size || size[0] <= 0 || size[1] <= 0) continue;
        result.push({ app, index, title: String(window.name() || ""), x: position[0], y: position[1], width: size[0], height: size[1] });
      }
    } catch (_) {}
  }
  return JSON.stringify(result);
}
`;

const FOCUS_APPLESCRIPT = `
on run argv
  set appName to item 1 of argv
  tell application "System Events"
    if not (exists process appName) then error "target application no longer exists"
    tell process appName to set frontmost to true
  end tell
  delay 0.2
end run
`;

interface MacWindowRecord extends ComputerWindow {
  index: number;
}

function encodeId(app: string, index: number, title: string): string {
  return Buffer.from(JSON.stringify({ app, index, title }), "utf8").toString("base64url");
}

function decodeId(id: string): { app: string; index: number; title: string } {
  try {
    const value = JSON.parse(Buffer.from(id, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.app !== "string" || !Number.isInteger(value.index) || typeof value.title !== "string")
      throw new Error();
    return { app: value.app, index: value.index as number, title: value.title };
  } catch {
    throw new Error("invalid macOS window_id; call computer_windows again");
  }
}

const MAC_KEY_NAMES: Record<string, string> = {
  CTRL: "ctrl",
  ALT: "alt",
  SHIFT: "shift",
  META: "cmd",
  ENTER: "return",
  TAB: "tab",
  ESCAPE: "esc",
  BACKSPACE: "delete",
  DELETE: "fwd-delete",
  UP: "arrow-up",
  DOWN: "arrow-down",
  LEFT: "arrow-left",
  RIGHT: "arrow-right",
  HOME: "home",
  END: "end",
  PAGEUP: "page-up",
  PAGEDOWN: "page-down",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `f${index + 1}`])),
};
const MAC_MODIFIERS = new Set(["ctrl", "alt", "shift", "cmd"]);

function cliclickCoordinate(value: number): string {
  // cliclickは負数をrelative値として解釈するため、絶対負座標には`=`が必要。
  return value < 0 ? `=${value}` : String(value);
}

export class MacOsDesktopDriver implements DesktopDriver {
  readonly platform = "macos" as const;

  constructor(private readonly runner: CommandRunner = runCommand) {}

  async listWindows(): Promise<ComputerWindow[]> {
    const output = await this.runner("/usr/bin/osascript", ["-l", "JavaScript", "-e", LIST_JXA]);
    let records: Array<Omit<MacWindowRecord, "id">>;
    try {
      records = JSON.parse(output.trim()) as Array<Omit<MacWindowRecord, "id">>;
    } catch {
      throw new Error(`macOS window enumeration returned invalid JSON: ${output.slice(0, 500)}`);
    }
    return records.map((record) => ({ ...record, id: encodeId(record.app, record.index, record.title) }));
  }

  private async target(windowId: string): Promise<MacWindowRecord> {
    const expected = decodeId(windowId);
    const records = (await this.listWindows()) as MacWindowRecord[];
    const record = records.find((item) => item.id === windowId);
    if (!record) {
      throw new Error(
        `target macOS window no longer matches (${expected.app} — ${expected.title}); call computer_windows again`,
      );
    }
    return record;
  }

  private async focus(target: MacWindowRecord): Promise<void> {
    try {
      await this.runner("/usr/bin/osascript", ["-e", FOCUS_APPLESCRIPT, target.app]);
    } catch (error) {
      throw new Error(
        `macOS Accessibility permission is required for ${target.app}. Enable it in System Settings > Privacy & Security > Accessibility. (${error})`,
      );
    }
  }

  async screenshot(windowId: string, outputPath: string): Promise<ComputerWindow> {
    const target = await this.target(windowId);
    await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    try {
      await this.runner("/usr/sbin/screencapture", [
        "-x",
        `-R${target.x},${target.y},${target.width},${target.height}`,
        path.resolve(outputPath),
      ]);
    } catch (error) {
      throw new Error(
        `macOS Screen Recording permission is required. Enable it in System Settings > Privacy & Security > Screen Recording. (${error})`,
      );
    }
    return target;
  }

  async click(
    windowId: string,
    x: number,
    y: number,
    button: ComputerMouseButton,
    clicks: number,
  ): Promise<ComputerWindow> {
    const target = await this.target(windowId);
    if (x < 0 || y < 0 || x >= target.width || y >= target.height)
      throw new Error("coordinates are outside the selected window");
    await this.focus(target);
    const global = `${cliclickCoordinate(target.x + x)},${cliclickCoordinate(target.y + y)}`;
    if (button === "middle") throw new Error("middle click is not supported by the macOS cliclick driver");
    const commands =
      button === "right"
        ? Array.from({ length: clicks }, () => `rc:${global}`)
        : [clicks === 2 ? `dc:${global}` : `c:${global}`];
    await this.runner("cliclick", commands);
    return target;
  }

  async typeText(windowId: string, text: string): Promise<ComputerWindow> {
    const target = await this.target(windowId);
    await this.focus(target);
    await this.runner("cliclick", [`t:${text}`]);
    return target;
  }

  async key(windowId: string, keys: string[]): Promise<ComputerWindow> {
    const target = await this.target(windowId);
    await this.focus(target);
    const mapped = keys.map((key) => MAC_KEY_NAMES[key] ?? key.toLowerCase());
    if (mapped.length === 1 && MAC_MODIFIERS.has(mapped[0])) {
      await this.runner("cliclick", [`kd:${mapped[0]}`, `ku:${mapped[0]}`]);
      return target;
    }
    const modifiers = mapped.slice(0, -1);
    const main = mapped.at(-1);
    if (!main) throw new Error("keys must contain at least one key");
    const press = /^[a-z0-9]$/.test(main) ? `t:${main}` : `kp:${main}`;
    const args = [...modifiers.map((key) => `kd:${key}`), press, ...modifiers.reverse().map((key) => `ku:${key}`)];
    await this.runner("cliclick", args);
    return target;
  }

  async scroll(windowId: string, x: number, y: number, deltaY: number): Promise<ComputerWindow> {
    void windowId;
    void x;
    void y;
    void deltaY;
    throw new Error(
      "macOS wheel scroll is unavailable: cliclick has no scroll command (`w:` means wait). Use computer_key PAGEUP/PAGEDOWN explicitly.",
    );
  }
}
