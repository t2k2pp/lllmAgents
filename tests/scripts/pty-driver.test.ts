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
    expect(driver.finalMarker).toBe("FINAL99");
    expect(driver.steerMarker).toBe("STEER_OK");
    expect(driver.pauseSentMarker).toBe("__PTY_PAUSE_SENT__");
    expect(driver.pauseReachedMarker).toBe("__PTY_PAUSE_REACHED__");
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
    expect(driver.args.join("\n")).toContain('send -- "/run pause\\r"');
    expect(driver.args.join("\n")).toContain('send -- "STEER_REQUEST\\r"');
    expect(driver.args.join("\n")).toContain("LLM API境界で一時停止");
    expect(driver.args.join("\n")).toContain('send -- "/run resume\\r"');
    expect(driver.args.join("\n")).toContain("STEER_OK");
    expect(driver.args.join("\n")).toContain('send -- "/quit\\r"');
    const previewAt = driver.args.join("\n").lastIndexOf("expect -re {PV42}");
    const finalAt = driver.args.join("\n").lastIndexOf("expect -re {FINAL99}");
    const steerAt = driver.args.join("\n").lastIndexOf('send -- "STEER_REQUEST\\r"');
    const steerResponseAt = driver.args.join("\n").lastIndexOf("expect -re {STEER_OK}");
    const pauseAt = driver.args.join("\n").lastIndexOf('send -- "/run pause\\r"');
    const pausedAt = driver.args.join("\n").lastIndexOf("expect -re {LLM API境界で一時停止}");
    const resumeAt = driver.args.join("\n").lastIndexOf('send -- "/run resume\\r"');
    const quitAt = driver.args.join("\n").lastIndexOf('send -- "/quit\\r"');
    expect(steerAt).toBeGreaterThan(previewAt);
    expect(pauseAt).toBeGreaterThan(previewAt);
    expect(steerAt).toBeGreaterThan(pauseAt);
    expect(finalAt).toBeGreaterThan(steerAt);
    expect(pausedAt).toBeGreaterThan(finalAt);
    expect(resumeAt).toBeGreaterThan(pausedAt);
    expect(steerResponseAt).toBeGreaterThan(finalAt);
    expect(steerResponseAt).toBeGreaterThan(resumeAt);
    expect(quitAt).toBeGreaterThan(steerResponseAt);
    expect(driver.env).toEqual({
      PTY_NODE: command.node,
      PTY_TSX: command.tsx,
      PTY_ENTRY: command.entry,
      TERM: "xterm-256color",
    });
  });
});
