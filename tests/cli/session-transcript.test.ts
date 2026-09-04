import { describe, expect, it } from "vitest";
import { ScreenManagerImpl } from "../../src/cli/screen-manager.js";
import { reconstructLegacyTranscript, restoreTerminalTranscript } from "../../src/cli/session-transcript.js";

describe("session terminal transcript", () => {
  it("version 1の保存stdoutをそのままscrollbackへ復元する", () => {
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin: null });
    screen.write("現在の画面\n");
    const result = restoreTerminalTranscript(
      screen,
      { version: 1, lines: ["> 過去の依頼", "過去の回答", ""], truncated: false },
      [],
    );
    expect(result.mode).toBe("exact");
    expect(screen.snapshotLines()).toEqual(["> 過去の依頼", "過去の回答", ""]);
  });

  it("stdout未保存の旧sessionは明示可能なlegacy modeで会話から再構成する", () => {
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin: null });
    const messages = [
      { role: "user" as const, content: "調べて" },
      { role: "assistant" as const, content: "結果です" },
    ];
    const result = restoreTerminalTranscript(screen, undefined, messages);
    expect(result.mode).toBe("legacy");
    expect(screen.snapshotLines().join("\n")).toContain("> 調べて");
    expect(screen.snapshotLines().join("\n")).toContain("結果です");
  });

  it("不正schemaをexact扱いせず、invalidとして再構成する", () => {
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin: null });
    const result = restoreTerminalTranscript(screen, { version: 2, lines: ["誤形式"] }, []);
    expect(result.mode).toBe("invalid");
    expect(result.transcript.version).toBe(1);
  });

  it("legacy再構成へtool名と結果も含める", () => {
    const lines = reconstructLegacyTranscript([
      {
        role: "assistant",
        content: "実行します",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call-1", content: "PASS" },
    ]);
    expect(lines.join("\n")).toContain("• bash");
    expect(lines.join("\n")).toContain("PASS");
  });
});
