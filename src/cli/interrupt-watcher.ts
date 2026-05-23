/**
 * エージェント処理中の ESC キーによるソフト中断を実現するモジュール。
 *
 * 通常 REPL では InteractiveInput が cleanup() で raw mode を外すため、
 * エージェント実行中はキー入力が Enter まで反応しない (Ctrl+C のみ通る)。
 * このモジュールは start() で stdin を raw mode に切り替えて ESC を監視し、
 * 受信時に onInterrupt() を一度だけ呼び出す。
 *
 * 非 TTY (パイプ) では no-op として振る舞う。
 */

const ESC = 0x1b;
/**
 * ESC 単独押下とエスケープシーケンス (矢印キーなど) を区別するためのデバウンス。
 * ESC バイト受信後この時間内に追加バイトが来たら「シーケンス」とみなし中断しない。
 * 50ms はターミナルが単一バーストで送るシーケンスを取りこぼさない実用値。
 */
const ESC_DEBOUNCE_MS = 50;

export interface InterruptWatcher {
  start(onInterrupt: () => void): void;
  stop(): void;
  isActive(): boolean;
}

class InterruptWatcherImpl implements InterruptWatcher {
  private active = false;
  private dataListener: ((chunk: Buffer) => void) | null = null;
  private endListener: (() => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private wasRawMode = false;

  isActive(): boolean {
    return this.active;
  }

  start(onInterrupt: () => void): void {
    if (this.active) {
      this.stop();
    }
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      return;
    }
    this.wasRawMode = stdin.isRaw;
    if (!stdin.isRaw) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    this.active = true;

    const fire = () => {
      this.stop();
      onInterrupt();
    };

    this.dataListener = (chunk: Buffer) => {
      if (chunk.length === 0) return;
      if (chunk[0] !== ESC) {
        return;
      }
      if (chunk.length > 1) {
        // ESC + 何か = エスケープシーケンス (矢印キーなど)。中断しない。
        if (this.pendingTimer) {
          clearTimeout(this.pendingTimer);
          this.pendingTimer = null;
        }
        return;
      }
      if (this.pendingTimer) {
        clearTimeout(this.pendingTimer);
      }
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        fire();
      }, ESC_DEBOUNCE_MS);
    };

    this.endListener = () => {
      this.stop();
    };

    stdin.on("data", this.dataListener);
    stdin.once("end", this.endListener);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    const stdin = process.stdin;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.dataListener) {
      stdin.removeListener("data", this.dataListener);
      this.dataListener = null;
    }
    if (this.endListener) {
      stdin.removeListener("end", this.endListener);
      this.endListener = null;
    }
    if (stdin.isTTY && stdin.isRaw && !this.wasRawMode) {
      stdin.setRawMode(false);
    }
  }
}

export const interruptWatcher: InterruptWatcher = new InterruptWatcherImpl();
