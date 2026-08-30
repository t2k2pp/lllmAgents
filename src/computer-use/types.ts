export type ComputerPlatform = "windows" | "macos" | "linux-x11";

export interface ComputerWindow {
  /** OS window handleを同一process内で扱うopaque ID。 */
  id: string;
  app: string;
  title: string;
  /** desktop全体でのwindow bounds。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ComputerMouseButton = "left" | "right" | "middle";

export interface DesktopDriver {
  readonly platform: ComputerPlatform;
  listWindows(): Promise<ComputerWindow[]>;
  screenshot(windowId: string, outputPath: string): Promise<ComputerWindow>;
  click(windowId: string, x: number, y: number, button: ComputerMouseButton, clicks: number): Promise<ComputerWindow>;
  typeText(windowId: string, text: string): Promise<ComputerWindow>;
  key(windowId: string, keys: string[]): Promise<ComputerWindow>;
  scroll(windowId: string, x: number, y: number, deltaY: number): Promise<ComputerWindow>;
}
