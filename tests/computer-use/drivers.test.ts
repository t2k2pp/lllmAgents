import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandOptions, CommandRunner } from "../../src/computer-use/process.js";
import { WindowsDesktopDriver } from "../../src/computer-use/windows-driver.js";
import { MacOsDesktopDriver } from "../../src/computer-use/macos-driver.js";
import { LinuxX11DesktopDriver } from "../../src/computer-use/linux-driver.js";

interface Invocation {
  command: string;
  args: string[];
  options?: CommandOptions;
}

const windowJson = JSON.stringify({
  id: "42",
  app: "Editor",
  title: "Document",
  x: 10,
  y: 20,
  width: 800,
  height: 600,
});

describe("native Computer Use drivers", () => {
  it("Windows は入力本文をコマンドラインへ展開せず base64 環境変数で渡す", async () => {
    const calls: Invocation[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      return windowJson;
    };
    const driver = new WindowsDesktopDriver(runner);
    await driver.typeText("42", "a'; Remove-Item C:\\important # 日本語");

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("powershell.exe");
    expect(calls[0].args.join(" ")).not.toContain("Remove-Item");
    const encoded = calls[0].options?.env?.LOCALLLM_ACTION_BASE64;
    expect(typeof encoded).toBe("string");
    if (!encoded) throw new Error("LOCALLLM_ACTION_BASE64 was not set");
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(payload.text).toBe("a'; Remove-Item C:\\important # 日本語");
  });

  it("macOS は再列挙した同一 window_id の領域だけを screencapture へ渡す", async () => {
    const calls: Invocation[] = [];
    const record = [{ app: "Notes", index: 0, title: "Memo", x: 12, y: 34, width: 640, height: 480 }];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      return command === "/usr/bin/osascript" && args.includes("JavaScript") ? JSON.stringify(record) : "";
    };
    const driver = new MacOsDesktopDriver(runner);
    const [target] = await driver.listWindows();
    const output = path.join(os.tmpdir(), "localllm-macos-driver-test.png");
    await driver.screenshot(target.id, output);

    const capture = calls.find((call) => call.command === "/usr/sbin/screencapture");
    expect(capture?.args).toContain("-R12,34,640,480");
    expect(capture?.args).not.toContain("-i");
  });

  it("macOS は cliclick の正式なmodifier/通常文字/special key構文へ変換する", async () => {
    const calls: Invocation[] = [];
    const record = [{ app: "Notes", index: 0, title: "Memo", x: 12, y: 34, width: 640, height: 480 }];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      return command === "/usr/bin/osascript" && args.includes("JavaScript") ? JSON.stringify(record) : "";
    };
    const driver = new MacOsDesktopDriver(runner);
    const [target] = await driver.listWindows();
    await driver.key(target.id, ["META", "A"]);
    await driver.key(target.id, ["BACKSPACE"]);
    await driver.key(target.id, ["DELETE"]);
    await driver.key(target.id, ["SHIFT"]);

    const keyboard = calls.filter((call) => call.command === "cliclick").map((call) => call.args);
    expect(keyboard).toEqual([["kd:cmd", "t:a", "ku:cmd"], ["kp:delete"], ["kp:fwd-delete"], ["kd:shift", "ku:shift"]]);
  });

  it("macOS は左側displayの負の絶対座標をcliclickの=構文で渡す", async () => {
    const calls: Invocation[] = [];
    const record = [{ app: "Notes", index: 0, title: "Memo", x: -900, y: -20, width: 640, height: 480 }];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      return command === "/usr/bin/osascript" && args.includes("JavaScript") ? JSON.stringify(record) : "";
    };
    const driver = new MacOsDesktopDriver(runner);
    const [target] = await driver.listWindows();
    await driver.click(target.id, 10, 30, "right", 2);

    const click = calls.find((call) => call.command === "cliclick");
    expect(click?.args).toEqual(["rc:=-890,10", "rc:=-890,10"]);
  });

  it("macOS はcliclickのwaitをwheel scrollと誤用せず明示失敗する", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("runner must not be called");
    };
    const driver = new MacOsDesktopDriver(runner);
    await expect(driver.scroll("window", 1, 2, -3)).rejects.toThrow("cliclick has no scroll command");
  });

  it("Linux X11 は選択ウィンドウを再検証して相対座標だけを渡す", async () => {
    const calls: Invocation[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === "getwindowname") return "Terminal\n";
      if (args[0] === "getwindowgeometry") return "X=100\nY=200\nWIDTH=900\nHEIGHT=700\n";
      return "";
    };
    const driver = new LinuxX11DesktopDriver(runner);
    await driver.click("99", 25, 30, "left", 1);

    expect(calls.some((call) => call.args.join(" ") === "windowactivate --sync 99")).toBe(true);
    expect(calls.some((call) => call.args.join(" ") === "mousemove --window 99 25 30 click --repeat 1 1")).toBe(true);
  });

  it("Linux X11 は対象外座標を入力イベント送信前に拒否する", async () => {
    const calls: Invocation[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === "getwindowname") return "Terminal\n";
      if (args[0] === "getwindowgeometry") return "X=0\nY=0\nWIDTH=100\nHEIGHT=80\n";
      return "";
    };
    const driver = new LinuxX11DesktopDriver(runner);

    await expect(driver.click("99", 100, 20, "left", 1)).rejects.toThrow("outside the selected window");
    expect(calls.some((call) => call.args[0] === "mousemove")).toBe(false);
  });
});
