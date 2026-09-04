/**
 * interrupt-watcher のテスト
 *
 * process.stdin を TTY 風のフェイクに差し替えて検証する:
 *  - ESC 単独押下 → デバウンス後に onInterrupt 発火
 *  - ESC + シーケンス (矢印キー等) → 発火しない
 *  - Ctrl+C (0x03) → SIGINT を合成 (raw mode 中は端末が SIGINT を生成しないため)
 *  - ハートビート → 外部要因で raw mode が外れ stdin が pause されても自動復旧
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { interruptWatcher } from "../../src/cli/interrupt-watcher.js";

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  private paused = true;
  rawModeCalls: boolean[] = [];

  setRawMode(flag: boolean): this {
    this.isRaw = flag;
    this.rawModeCalls.push(flag);
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  isPaused(): boolean {
    return this.paused;
  }
}

describe("interruptWatcher", () => {
  let fakeStdin: FakeStdin;
  const realStdin = process.stdin;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeStdin = new FakeStdin();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });
  });

  afterEach(() => {
    interruptWatcher.stop();
    Object.defineProperty(process, "stdin", {
      value: realStdin,
      configurable: true,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ESC 単独押下でデバウンス後に onInterrupt が1回だけ発火する", () => {
    const onInterrupt = vi.fn();
    interruptWatcher.start(onInterrupt);

    fakeStdin.emit("data", Buffer.from([0x1b]));
    expect(onInterrupt).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    // 発火後は自動 stop している
    expect(interruptWatcher.isActive()).toBe(false);
  });

  it("ESC + 後続バイト (矢印キー等のシーケンス) では発火しない", () => {
    const onInterrupt = vi.fn();
    interruptWatcher.start(onInterrupt);

    // 矢印キー: ESC [ A が1チャンクで届く
    fakeStdin.emit("data", Buffer.from("\x1b[A"));
    vi.advanceTimersByTime(100);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("Shift+TabがESCと後続chunkに分割されても単独ESC中断にしない", () => {
    const onInterrupt = vi.fn();
    interruptWatcher.start(onInterrupt);

    fakeStdin.emit("data", Buffer.from([0x1b]));
    vi.advanceTimersByTime(10);
    fakeStdin.emit("data", Buffer.from("[Z"));
    vi.advanceTimersByTime(100);

    expect(onInterrupt).not.toHaveBeenCalled();
    expect(interruptWatcher.isActive()).toBe(true);
  });

  it("Ctrl+C (0x03) を受信したら SIGINT を合成する", () => {
    const onInterrupt = vi.fn();
    let sigintCount = 0;
    const realEmit = process.emit.bind(process);
    vi.spyOn(process, "emit").mockImplementation(((event: string, ...args: unknown[]) => {
      if (event === "SIGINT") {
        sigintCount++;
        return true;
      }
      return (realEmit as (...a: unknown[]) => boolean)(event, ...args);
    }) as typeof process.emit);

    interruptWatcher.start(onInterrupt);
    fakeStdin.emit("data", Buffer.from([0x03]));

    expect(sigintCount).toBe(1);
    // SIGINT 合成は onInterrupt (ESC 経路) ではない
    expect(onInterrupt).not.toHaveBeenCalled();
    // 監視自体は継続 (2回目の Ctrl+C = プロセス終了を repl 側で判定するため)
    expect(interruptWatcher.isActive()).toBe(true);
  });

  it("外部要因で raw mode が外れ stdin が pause されてもハートビートで復旧する", () => {
    interruptWatcher.start(() => {});
    expect(fakeStdin.isRaw).toBe(true);

    // inquirer の後始末を模倣: raw mode を外して pause
    fakeStdin.setRawMode(false);
    fakeStdin.pause();

    vi.advanceTimersByTime(600);
    expect(fakeStdin.isRaw).toBe(true);
    expect(fakeStdin.isPaused()).toBe(false);
  });

  it("stop() でハートビートも止まり raw mode が復元される", () => {
    interruptWatcher.start(() => {});
    interruptWatcher.stop();
    expect(fakeStdin.isRaw).toBe(false);

    // stop 後にずらしても復旧処理は走らない
    fakeStdin.pause();
    vi.advanceTimersByTime(2000);
    expect(fakeStdin.isPaused()).toBe(true);
  });
});
