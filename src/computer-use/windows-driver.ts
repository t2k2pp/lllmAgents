import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ComputerMouseButton, ComputerWindow, DesktopDriver } from "./types.js";
import { runCommand, type CommandRunner } from "./process.js";

const NATIVE_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class LocalLlmDesktopNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

  public static IntPtr[] VisibleWindows() {
    var handles = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr _) {
      if (!IsWindowVisible(hWnd)) return true;
      var title = new StringBuilder(2048);
      GetWindowText(hWnd, title, title.Capacity);
      RECT rect;
      if (title.Length > 0 && GetWindowRect(hWnd, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top) handles.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }

  public static string Title(IntPtr hWnd) {
    var title = new StringBuilder(2048);
    GetWindowText(hWnd, title, title.Capacity);
    return title.ToString();
  }

  public static void Focus(IntPtr hWnd) {
    if (!IsWindow(hWnd) || !IsWindowVisible(hWnd)) throw new InvalidOperationException("target window no longer exists or is hidden");
    if (IsIconic(hWnd)) ShowWindowAsync(hWnd, 9);
    var foreground = GetForegroundWindow();
    uint ignored;
    var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
    var targetThread = GetWindowThreadProcessId(hWnd, out ignored);
    var currentThread = GetCurrentThreadId();
    var attachedForeground = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
    var attachedTarget = targetThread != 0 && targetThread != currentThread && AttachThreadInput(currentThread, targetThread, true);
    try {
      BringWindowToTop(hWnd);
      SetActiveWindow(hWnd);
      SetForegroundWindow(hWnd);
    } finally {
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
    Thread.Sleep(180);
    if (GetForegroundWindow() != hWnd) throw new InvalidOperationException("target window could not be focused; activate it once and retry");
  }

  static INPUT KeyInput(ushort vk, ushort scan, uint flags) {
    return new INPUT { type = 1, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } } };
  }

  static void Send(INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new InvalidOperationException("SendInput was rejected by Windows");
  }

  public static void TypeUnicode(string text) {
    foreach (char value in text) Send(new INPUT[] { KeyInput(0, value, 0x0004), KeyInput(0, value, 0x0004 | 0x0002) });
  }

  static ushort KeyCode(string name) {
    var upper = name.ToUpperInvariant();
    if (upper.Length == 1 && ((upper[0] >= 'A' && upper[0] <= 'Z') || (upper[0] >= '0' && upper[0] <= '9'))) return upper[0];
    switch (upper) {
      case "CTRL": return 0x11; case "ALT": return 0x12; case "SHIFT": return 0x10; case "META": return 0x5B;
      case "ENTER": return 0x0D; case "TAB": return 0x09; case "ESCAPE": return 0x1B; case "BACKSPACE": return 0x08;
      case "DELETE": return 0x2E; case "UP": return 0x26; case "DOWN": return 0x28; case "LEFT": return 0x25; case "RIGHT": return 0x27;
      case "HOME": return 0x24; case "END": return 0x23; case "PAGEUP": return 0x21; case "PAGEDOWN": return 0x22;
      default:
        if (upper.Length >= 2 && upper[0] == 'F') {
          int number;
          if (Int32.TryParse(upper.Substring(1), out number) && number >= 1 && number <= 12) return (ushort)(0x70 + number - 1);
        }
        throw new ArgumentException("unsupported key: " + name);
    }
  }

  public static void SendChord(string[] names) {
    var codes = new List<ushort>();
    foreach (var name in names) codes.Add(KeyCode(name));
    var inputs = new List<INPUT>();
    foreach (var code in codes) inputs.Add(KeyInput(code, 0, 0));
    codes.Reverse();
    foreach (var code in codes) inputs.Add(KeyInput(code, 0, 0x0002));
    Send(inputs.ToArray());
  }

  public static void Click(int x, int y, string button, int clicks) {
    SetCursorPos(x, y);
    uint down; uint up;
    switch (button) {
      case "right": down = 0x0008; up = 0x0010; break;
      case "middle": down = 0x0020; up = 0x0040; break;
      default: down = 0x0002; up = 0x0004; break;
    }
    for (var i = 0; i < clicks; i++) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(80); }
  }

  public static void Scroll(int x, int y, int delta) {
    SetCursorPos(x, y);
    mouse_event(0x0800, 0, 0, delta * 120, UIntPtr.Zero);
  }
}
`;

const COMMON_POWERSHELL = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition $env:LOCALLLM_NATIVE_SOURCE -Language CSharp
function Get-TargetWindow([string]$id) {
  $handle = [IntPtr]([Int64]::Parse($id, [Globalization.CultureInfo]::InvariantCulture))
  if (-not [LocalLlmDesktopNative]::IsWindow($handle) -or -not [LocalLlmDesktopNative]::IsWindowVisible($handle)) { throw 'target window no longer exists or is hidden' }
  $rect = New-Object LocalLlmDesktopNative+RECT
  if (-not [LocalLlmDesktopNative]::GetWindowRect($handle, [ref]$rect)) { throw 'cannot read target window bounds' }
  [uint32]$pidValue = 0
  [void][LocalLlmDesktopNative]::GetWindowThreadProcessId($handle, [ref]$pidValue)
  $app = try { (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch { 'unknown' }
  [pscustomobject]@{ Handle=$handle; id=$id; app=$app; title=[LocalLlmDesktopNative]::Title($handle); x=$rect.Left; y=$rect.Top; width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top }
}
`;

const LIST_SCRIPT = `${COMMON_POWERSHELL}
$items = foreach ($handle in [LocalLlmDesktopNative]::VisibleWindows()) { Get-TargetWindow ([string]$handle.ToInt64()) }
ConvertTo-Json -Compress -InputObject @($items)
`;

const SCREENSHOT_SCRIPT = `${COMMON_POWERSHELL}
Add-Type -AssemblyName System.Drawing
$target = Get-TargetWindow $env:LOCALLLM_WINDOW_ID
if ($target.width -le 0 -or $target.height -le 0) { throw 'target window has invalid bounds' }
[LocalLlmDesktopNative]::Focus($target.Handle)
$bitmap = New-Object Drawing.Bitmap $target.width, $target.height
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
try {
  if (-not [LocalLlmDesktopNative]::PrintWindow($target.Handle, $hdc, 2)) { throw 'PrintWindow rejected the target window capture' }
  $graphics.ReleaseHdc($hdc)
  $hdc = [IntPtr]::Zero
  $bitmap.Save($env:LOCALLLM_SCREENSHOT_PATH, [Drawing.Imaging.ImageFormat]::Png)
} finally {
  if ($hdc -ne [IntPtr]::Zero) { $graphics.ReleaseHdc($hdc) }
  $graphics.Dispose()
  $bitmap.Dispose()
}
$target | Select-Object id,app,title,x,y,width,height | ConvertTo-Json -Compress
`;

const ACTION_SCRIPT = `${COMMON_POWERSHELL}
$payloadText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:LOCALLLM_ACTION_BASE64))
$payload = $payloadText | ConvertFrom-Json
$target = Get-TargetWindow ([string]$payload.windowId)
if ($payload.PSObject.Properties.Name -contains 'x') {
  if ($payload.x -lt 0 -or $payload.y -lt 0 -or $payload.x -ge $target.width -or $payload.y -ge $target.height) { throw 'coordinates are outside the selected window' }
}
[LocalLlmDesktopNative]::Focus($target.Handle)
switch ($payload.action) {
  'click' { [LocalLlmDesktopNative]::Click($target.x + $payload.x, $target.y + $payload.y, $payload.button, $payload.clicks) }
  'type' { [LocalLlmDesktopNative]::TypeUnicode($payload.text) }
  'key' { [LocalLlmDesktopNative]::SendChord([string[]]$payload.keys) }
  'scroll' { [LocalLlmDesktopNative]::Scroll($target.x + $payload.x, $target.y + $payload.y, $payload.deltaY) }
  default { throw ('unsupported action: ' + $payload.action) }
}
$target | Select-Object id,app,title,x,y,width,height | ConvertTo-Json -Compress
`;

function encoded(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function parseWindow(value: unknown): ComputerWindow {
  if (!value || typeof value !== "object") throw new Error("Windows driver returned an invalid window record");
  const item = value as Record<string, unknown>;
  const result: ComputerWindow = {
    id: String(item.id),
    app: String(item.app ?? "unknown"),
    title: String(item.title ?? ""),
    x: Number(item.x),
    y: Number(item.y),
    width: Number(item.width),
    height: Number(item.height),
  };
  if (!result.id || !Number.isFinite(result.width) || result.width <= 0 || result.height <= 0) {
    throw new Error("Windows driver returned invalid window bounds");
  }
  return result;
}

export class WindowsDesktopDriver implements DesktopDriver {
  readonly platform = "windows" as const;

  constructor(
    private readonly runner: CommandRunner = runCommand,
    private readonly powershell = "powershell.exe",
  ) {}

  private async powershellJson(script: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<unknown> {
    const output = await this.runner(
      this.powershell,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)],
      {
        env: { ...process.env, LOCALLLM_NATIVE_SOURCE: NATIVE_SOURCE, ...extraEnv },
        timeoutMs: 20_000,
      },
    );
    try {
      return JSON.parse(output.trim());
    } catch {
      throw new Error(`Windows Computer Use returned invalid JSON: ${output.slice(0, 500)}`);
    }
  }

  async listWindows(): Promise<ComputerWindow[]> {
    const value = await this.powershellJson(LIST_SCRIPT);
    const items = Array.isArray(value) ? value : [value];
    return items.filter(Boolean).map(parseWindow);
  }

  async screenshot(windowId: string, outputPath: string): Promise<ComputerWindow> {
    await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    const value = await this.powershellJson(SCREENSHOT_SCRIPT, {
      LOCALLLM_WINDOW_ID: windowId,
      LOCALLLM_SCREENSHOT_PATH: path.resolve(outputPath),
    });
    return parseWindow(value);
  }

  private async action(payload: Record<string, unknown>): Promise<ComputerWindow> {
    const value = await this.powershellJson(ACTION_SCRIPT, {
      LOCALLLM_ACTION_BASE64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    });
    return parseWindow(value);
  }

  click(windowId: string, x: number, y: number, button: ComputerMouseButton, clicks: number) {
    return this.action({ action: "click", windowId, x, y, button, clicks });
  }

  typeText(windowId: string, text: string) {
    return this.action({ action: "type", windowId, text });
  }

  key(windowId: string, keys: string[]) {
    return this.action({ action: "key", windowId, keys });
  }

  scroll(windowId: string, x: number, y: number, deltaY: number) {
    return this.action({ action: "scroll", windowId, x, y, deltaY });
  }
}
