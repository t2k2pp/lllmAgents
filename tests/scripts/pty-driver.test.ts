import { describe, expect, it } from "vitest";
import { interactivePtyEnv, ptyDriver } from "../../scripts/pty-driver.js";

const command = { node: "/runtime/node", tsx: "/repo/tsx.mjs", entry: "/repo/index.ts" };

describe("PTY smoke driver", () => {
  it("CI上でも対話spinnerを描画する子環境を作る", () => {
    const env = interactivePtyEnv({ CI: "true", KEEP: "yes" }, { TERM: "xterm-256color" });
    expect(env).toEqual({ KEEP: "yes", TERM: "xterm-256color" });
    expect("CI" in env).toBe(false);
  });

  it("Linuxではutil-linux scriptを使い、親プロセスが入力を送る", () => {
    const driver = ptyDriver("linux", command);
    expect(driver.executable).toBe("script");
    expect(driver.args[0]).toBe("-qec");
    expect(driver.parentSubmits).toBe(true);
    expect(driver.scrollMarker).toBe("__PTY_SCROLL_SEEN__");
    expect(driver.imeMarker).toBe("__PTY_IME_SEEN__");
    expect(driver.previewMarker).toBe("PV42");
    expect(driver.previewSubmittedMarker).toBe("__PTY_PREVIEW_SUBMITTED__");
    expect(driver.processingInputMarker).toBe("処理中・追加入力");
    expect(driver.modeCycleSeenMarker).toBe("モード: Autorun");
    expect(driver.steerVisibleMarker).toBe("STEER_REQUEST");
    expect(driver.finalMarker).toBe("FINAL99");
    expect(driver.steerMarker).toBe("STEER_OK");
    expect(driver.pauseSentMarker).toBe("__PTY_PAUSE_SENT__");
    expect(driver.pauseReachedMarker).toBe("__PTY_PAUSE_REACHED__");
    expect(driver.parallelSentMarker).toBe("__PTY_PARALLEL_SENT__");
    expect(driver.resumeSentMarker).toBe("__PTY_RESUME_SENT__");
    expect(driver.env.TERM).toBe("xterm-256color");
  });

  it("macOSではpipe stdin非互換のscriptを避け、expect内でCRを送る", () => {
    const driver = ptyDriver("darwin", command);
    expect(driver.executable).toBe("expect");
    expect(driver.parentSubmits).toBe(false);
    expect(driver.args.join("\n")).toContain('send -- "/help\\r"');
    expect(driver.args.join("\n")).toContain('send -- "\\033\\[<64;10;4M"');
    expect(driver.args.join("\n")).toContain('send -- "\\033\\[<65;10;4M"');
    expect(driver.args.join("\n")).toContain("expect -re {> }");
    expect(driver.args.join("\n")).toContain("__PTY_SCROLL_SEEN__");
    expect(driver.args.join("\n")).toContain("__PTY_IME_SEEN__");
    expect(driver.args.join("\n")).toContain("stty columns 20 rows 24");
    expect(driver.args.join("\n")).toContain("日本語入力の右端折返し確認");
    expect(driver.args.join("\n")).toContain('send -- "PREVIEW_REQUEST\\r"');
    expect(driver.args.join("\n")).toContain("__PTY_PREVIEW_SUBMITTED__");
    expect(driver.args.join("\n")).toContain("__PTY_PREVIEW_TIMEOUT__");
    expect(driver.args.join("\n")).toContain("PV42");
    expect(driver.args.join("\n")).toContain("FINAL99");
    expect(driver.args.join("\n")).toContain("expect -re {処理中・追加入力}");
    expect(driver.args.join("\n")).toContain('send -- "/run pause\\r"');
    expect(driver.args.join("\n")).toContain('send -- "\\033\\[Z"');
    expect(driver.args.join("\n")).toContain("expect -re {モード: Autorun}");
    expect(driver.args.join("\n")).toContain('send -- "STEER_REQUEST"');
    expect(driver.args.join("\n")).toContain("expect -re {STEER_REQUEST}");
    expect(driver.args.join("\n")).toContain('send -- "\\r"');
    expect(driver.args.join("\n")).toContain("runをLLM API境界で一時停止しました");
    expect(driver.args.join("\n")).toContain('send -- "/parallel 4\\r"');
    expect(driver.args.join("\n")).toContain("並列実行上限を 4 に設定しました");
    expect(driver.args.join("\n")).toContain('send -- "/run resume\\r"');
    expect(driver.args.join("\n")).toContain("STEER_OK");
    expect(driver.args.join("\n")).toContain('send -- "/quit\\r"');
    const previewAt = driver.args.join("\n").lastIndexOf("expect -re {PV42}");
    const finalAt = driver.args.join("\n").lastIndexOf("expect -re {FINAL99}");
    const modeCycleAt = driver.args.join("\n").lastIndexOf('send -- "\\033\\[Z"');
    const modeSeenAt = driver.args.join("\n").lastIndexOf("expect -re {モード: Autorun}");
    const steerAt = driver.args.join("\n").lastIndexOf('send -- "STEER_REQUEST"');
    const steerVisibleAt = driver.args.join("\n").lastIndexOf("expect -re {STEER_REQUEST}");
    const steerResponseAt = driver.args.join("\n").lastIndexOf("expect -re {STEER_OK}");
    const pauseAt = driver.args.join("\n").lastIndexOf('send -- "/run pause\\r"');
    const pausedAt = driver.args.join("\n").lastIndexOf("expect -re {runをLLM API境界で一時停止しました}");
    const parallelAt = driver.args.join("\n").lastIndexOf('send -- "/parallel 4\\r"');
    const resumeAt = driver.args.join("\n").lastIndexOf('send -- "/run resume\\r"');
    const quitAt = driver.args.join("\n").lastIndexOf('send -- "/quit\\r"');
    expect(steerAt).toBeGreaterThan(previewAt);
    expect(pauseAt).toBeGreaterThan(previewAt);
    expect(modeCycleAt).toBeGreaterThan(pauseAt);
    expect(modeSeenAt).toBeGreaterThan(modeCycleAt);
    expect(steerAt).toBeGreaterThan(modeSeenAt);
    expect(steerVisibleAt).toBeGreaterThan(steerAt);
    expect(pausedAt).toBeGreaterThan(steerAt);
    expect(parallelAt).toBeGreaterThan(pausedAt);
    expect(resumeAt).toBeGreaterThan(parallelAt);
    // buffered responseはAPI完了時にpauseへ到達し、resume後にfinalを確定表示する。
    expect(finalAt).toBeGreaterThan(resumeAt);
    expect(steerResponseAt).toBeGreaterThan(resumeAt);
    expect(steerResponseAt).toBeGreaterThan(finalAt);
    expect(quitAt).toBeGreaterThan(steerResponseAt);
    expect(driver.env).toEqual({
      PTY_NODE: command.node,
      PTY_TSX: command.tsx,
      PTY_ENTRY: command.entry,
      TERM: "xterm-256color",
    });
  });
});
