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
const CTRL_C = 0x03;
/**
 * ESC 単独押下とエスケープシーケンス (矢印キーなど) を区別するためのデバウンス。
 * ESC バイト受信後この時間内に追加バイトが来たら「シーケンス」とみなし中断しない。
 * 50ms はターミナルが単一バーストで送るシーケンスを取りこぼさない実用値。
 */
const ESC_DEBOUNCE_MS = 50;
/**
 * raw mode / stdin 状態の自己修復間隔。
 * 監視中に inquirer (権限確認 / ask_user) が閉じると raw mode が外れ stdin が pause され、
 * 以降の ESC / Ctrl+C が Enter まで届かなくなる。定期的に検査して復旧する。
 */
const HEARTBEAT_MS = 500;

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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
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
      // raw mode 中は端末が SIGINT を生成しない (ISIG / ENABLE_PROCESSED_INPUT が無効) ため、
      // Ctrl+C は 0x03 バイトとしてここに届く。検知したら SIGINT を合成して
      // repl.ts の既存ハンドラ (1回=ソフト中断 / 2回=終了) に委譲する。
      if (chunk.includes(CTRL_C)) {
        if (this.pendingTimer) {
          clearTimeout(this.pendingTimer);
          this.pendingTimer = null;
        }
        process.emit("SIGINT");
        return;
      }
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

    // 自己修復ハートビート: 監視中に inquirer プロンプト (権限確認 / ask_user) が閉じると
    // inquirer 側の後始末で raw mode が外れ stdin が pause される。そのままだと残りの
    // エージェント実行中 ESC / Ctrl+C が一切届かないため、定期的に raw mode と flowing を回復する。
    this.heartbeatTimer = setInterval(() => {
      if (!this.active || !stdin.isTTY) return;
      if (!stdin.isRaw) {
        stdin.setRawMode(true);
      }
      if (stdin.isPaused()) {
        stdin.resume();
      }
    }, HEARTBEAT_MS);
    // heartbeat がプロセスの終了を妨げないようにする
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    const stdin = process.stdin;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
