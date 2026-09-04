/**
 * 長時間ツール実行中の進捗インジケータ。
 *
 * 1 秒経過したら spinner と経過秒数を表示。
 * 5 秒経過で「ESC で中断 / Ctrl+C で強制」案内を 1 回だけ追加。
 * end() で行をクリアして次の出力に影響を残さない。
 *
 * 非 TTY (パイプ) では何も描画しない。
 *
 * ## ライブ領域のソフト所有者 (docs/tui-alternate-screen.md §5)
 *
 * スピナーは「一定間隔で勝手に書く」 という、所有権にとって最も厄介な存在である。
 * 自前描画なので `redraw()` を渡せる = ソフト所有者になれる。ライブ領域を所有している
 * 間は、割り込み出力が来ても ScreenManager が描き直してくれる。
 *
 * 描画は必ず `screen.writeLive()` を通す。`process.stdout.write` は OutputRouter に
 * 差し替えられており、そのまま使うと自分のフレームがスクロールバックへ記録される。
 */

import chalk from "chalk";
import { screen } from "./screen-manager.js";

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
  /** ライブ領域の解放関数 (§4.2) */
  private releaseLive: (() => void) | null = null;

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
    // 処理中composerが常時表示されている間は、その下端をprogress描画で奪わない。
    // toolの開始・完了は確定stdoutへ別途表示されるため、操作可能性を優先する。
    if (screen.currentOwner() === "processing-input") {
      return;
    }
    this.active = true;
    this.startMs = Date.now();
    this.currentToolName = toolName;
    this.currentSummary = summary;
    this.rendered = false;
    this.hintShown = false;
    this.frameIndex = 0;
    // ライブ領域をソフト所有する。割り込み出力が来ても消えず、
    // inquirer が排他所有している間は writeLive が自動的に黙る。
    this.releaseLive = screen.acquireLive({
      name: "progress-indicator",
      // 最初の 1 秒間はまだ何も描かない (rendered=false)。所有はしていても高さ 0
      redraw: () => {
        if (this.rendered) this.render();
      },
      height: () => (this.rendered ? 1 : 0),
      clear: () => {
        if (this.rendered) this.clearLine();
      },
    });
    this.firstRenderTimer = setTimeout(() => {
      this.firstRenderTimer = null;
      this.rendered = true;
      this.tick();
      this.spinnerTimer = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
        this.tick();
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
    if (this.rendered && !screen.isAlternate()) {
      this.clearLine();
    }
    this.rendered = false;
    this.releaseLive?.();
    this.releaseLive = null;
  }

  /**
   * タイマーからの 1 コマ更新。
   * 代替画面ではカーソル位置を握っているのは ScreenManager なので、自分で描かず
   * 再描画を要求する (ScreenManager が位置を決めて redraw() を呼び返す)。
   */
  private tick(): void {
    if (screen.isAlternate()) {
      screen.refreshLive();
      return;
    }
    this.render();
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
    screen.writeLive(line);
  }

  private clearLine(): void {
    screen.writeLive("\r\x1b[2K");
  }

  private truncate(s: string, max: number): string {
    const oneLine = s.replace(/\s+/g, " ").trim();
    if (oneLine.length <= max) return oneLine;
    return oneLine.slice(0, max - 1) + "…";
  }
}

export const progressIndicator: ProgressIndicator = new ProgressIndicatorImpl();
