import type { ComputerPlatform, DesktopDriver } from "./types.js";
import { WindowsDesktopDriver } from "./windows-driver.js";
import { MacOsDesktopDriver } from "./macos-driver.js";
import { LinuxX11DesktopDriver } from "./linux-driver.js";

export function createDesktopDriver(platform: ComputerPlatform): DesktopDriver {
  switch (platform) {
    case "windows":
      return new WindowsDesktopDriver();
    case "macos":
      return new MacOsDesktopDriver();
    case "linux-x11":
      return new LinuxX11DesktopDriver();
  }
}

export * from "./capability.js";
export * from "./types.js";
