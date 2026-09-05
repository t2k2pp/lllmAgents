import { screen, type ScreenManager } from "./screen-manager.js";

/**
 * Runtime failures must remain visible in Alternate Screen. In classic/piped
 * operation they keep the existing stderr contract for shell redirection.
 */
export function writeRuntimeError(
  text: string,
  target: ScreenManager = screen,
  stderr: (text: string) => void = (value) => process.stderr.write(value),
): void {
  const line = text.endsWith("\n") ? text : `${text}\n`;
  if (target.isAlternate()) target.write(line);
  else stderr(line);
}
