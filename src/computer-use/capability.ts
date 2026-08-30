import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type { Config } from "../config/types.js";
import type { ComputerPlatform } from "./types.js";

export interface ComputerUseCapability {
  ready: boolean;
  reason: string;
  platform?: ComputerPlatform;
  source: "explicit-cli" | "config" | "disabled";
}

export interface CapabilityDetectionInput {
  requested: boolean;
  requestSource?: "explicit-cli" | "config";
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  commandExists?: (command: string) => boolean;
}

function commandExists(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) return fs.existsSync(command);
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(locator, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

export function detectComputerUseCapability(input: CapabilityDetectionInput): ComputerUseCapability {
  const source = input.requestSource ?? (input.requested ? "explicit-cli" : "disabled");
  if (!input.requested) {
    return {
      ready: false,
      reason: "disabled: native desktop access requires explicit opt-in (--computer-use or features.computerUse=on)",
      source: "disabled",
    };
  }

  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const has = input.commandExists ?? commandExists;
  if (platform === "win32") {
    if (!has("powershell.exe") && !has("pwsh.exe")) {
      return { ready: false, reason: "PowerShell is required for Windows Computer Use", source };
    }
    return { ready: true, reason: "Windows User32 + PowerShell ready", platform: "windows", source };
  }
  if (platform === "darwin") {
    const missing = ["/usr/bin/osascript", "/usr/sbin/screencapture", "cliclick"].filter((item) => !has(item));
    if (missing.length > 0) {
      return { ready: false, reason: `macOS Computer Use dependency missing: ${missing.join(", ")}`, source };
    }
    return {
      ready: true,
      reason:
        "macOS System Events + screencapture + cliclick ready; Accessibility and Screen Recording permission are required",
      platform: "macos",
      source,
    };
  }
  if (platform === "linux") {
    if (env.XDG_SESSION_TYPE?.toLowerCase() === "wayland") {
      return {
        ready: false,
        reason: "Wayland native input injection is not supported; use an explicit X11 session with DISPLAY",
        source,
      };
    }
    if (!env.DISPLAY) {
      return { ready: false, reason: "Linux Computer Use requires an X11 DISPLAY", source };
    }
    const missing = ["xdotool", "import"].filter((item) => !has(item));
    if (missing.length > 0) {
      return {
        ready: false,
        reason: `Linux X11 Computer Use dependency missing: ${missing.join(", ")} (install xdotool and ImageMagick)`,
        source,
      };
    }
    return { ready: true, reason: "Linux X11 + xdotool + ImageMagick ready", platform: "linux-x11", source };
  }
  return { ready: false, reason: `unsupported OS for native Computer Use: ${platform}`, source };
}

export function probeComputerUseCapability(config: Config, cliRequested: boolean): ComputerUseCapability {
  const configRequested = config.features?.computerUse === "on";
  return detectComputerUseCapability({
    requested: cliRequested || configRequested,
    requestSource: cliRequested ? "explicit-cli" : configRequested ? "config" : undefined,
  });
}
