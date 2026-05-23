/**
 * 長時間ツール実行中の進捗インジケータ。
 *
 * 1 秒経過したら spinner と経過秒数を表示。
 * 5 秒経過で「ESC で中断 / Ctrl+C で強制」案内を 1 回だけ追加。
 * end() で行をクリアして次の出力に影響を残さない。
 *
 * 非 TTY (パイプ) では何も描画しない。
 */

import chalk from "chalk";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const FIRST_RENDER_DELAY_MS = 1000;
const HINT_DELAY_MS = 5000;

export interface ProgressIndicator {
  begin(toolName: string, summary: string): void;
  end(): void;
  isActive(): boolean;
}

class ProgressIndicatorImpl implements ProgressIndicator {
  private active = false;
  private startMs = 0;
  private firstRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private currentToolName = "";
  private currentSummary = "";
  private rendered = false;
  private hintShown = false;

  isActive(): boolean {
    return this.active;
  }

  begin(toolName: string, summary: string): void {
    if (this.active) {
      this.end();
    }
    if (!process.stdout.isTTY) {
      return;
    }
    this.active = true;
    this.startMs = Date.now();
    this.currentToolName = toolName;
    this.currentSummary = summary;
    this.rendered = false;
    this.hintShown = false;
    this.frameIndex = 0;
    this.firstRenderTimer = setTimeout(() => {
      this.firstRenderTimer = null;
      this.render();
      this.spinnerTimer = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
        this.render();
      }, SPINNER_INTERVAL_MS);
    }, FIRST_RENDER_DELAY_MS);
  }

  end(): void {
    if (!this.active) return;
    this.active = false;
    if (this.firstRenderTimer) {
      clearTimeout(this.firstRenderTimer);
      this.firstRenderTimer = null;
    }
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.rendered) {
      this.clearLine();
    }
  }

  private render(): void {
    const elapsed = Date.now() - this.startMs;
    const seconds = Math.floor(elapsed / 1000);
    const frame = SPINNER_FRAMES[this.frameIndex];
    const summary = this.truncate(this.currentSummary, 70);
    let line = `  ${chalk.cyan(frame)} ${chalk.dim(`[${this.currentToolName}]`)} ${summary} ${chalk.dim(`(${seconds}s)`)}`;
    if (elapsed >= HINT_DELAY_MS && !this.hintShown) {
      this.hintShown = true;
      line += chalk.dim("  · ESC で中断 / Ctrl+C で強制");
    }
    this.clearLine();
    process.stdout.write(line);
    this.rendered = true;
  }

  private clearLine(): void {
    process.stdout.write("\r\x1b[2K");
  }

  private truncate(s: string, max: number): string {
    const oneLine = s.replace(/\s+/g, " ").trim();
    if (oneLine.length <= max) return oneLine;
    return oneLine.slice(0, max - 1) + "…";
  }
}

export const progressIndicator: ProgressIndicator = new ProgressIndicatorImpl();
