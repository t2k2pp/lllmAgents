import { describe, expect, it } from "vitest";
import { ptyDriver } from "../../scripts/pty-driver.js";

const command = { node: "/runtime/node", tsx: "/repo/tsx.mjs", entry: "/repo/index.ts" };

describe("PTY smoke driver", () => {
  it("Linuxではutil-linux scriptを使い、親プロセスが入力を送る", () => {
    const driver = ptyDriver("linux", command);
    expect(driver.executable).toBe("script");
    expect(driver.args[0]).toBe("-qec");
    expect(driver.parentSubmits).toBe(true);
  });

  it("macOSではpipe stdin非互換のscriptを避け、expect内でCRを送る", () => {
    const driver = ptyDriver("darwin", command);
    expect(driver.executable).toBe("expect");
    expect(driver.parentSubmits).toBe(false);
    expect(driver.args.join("\n")).toContain('send -- "/quit\\r"');
    expect(driver.env).toEqual({ PTY_NODE: command.node, PTY_TSX: command.tsx, PTY_ENTRY: command.entry });
  });
});
