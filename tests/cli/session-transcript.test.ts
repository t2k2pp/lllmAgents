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

  it("保存stdoutに欠けた対話本文がある場合は会話履歴から補完する", () => {
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin: null });
    const result = restoreTerminalTranscript(
      screen,
      { version: 1, lines: ["> 調べて", "回答の先頭だけ", ""], truncated: false },
      [
        { role: "user", content: "調べて" },
        { role: "assistant", content: "回答の先頭だけでなく、本来表示すべき後半も含む完全な回答です。" },
      ],
    );

    expect(result.mode).toBe("recovered");
    expect(result.recoveredMessageCount).toBe(1);
    const restored = screen.snapshotLines().join("\n");
    expect(restored).toContain("保存stdoutから欠けていた会話");
    expect(restored).toContain("回答の先頭だけでなく、本来表示すべき後半も含む完全な回答です。");

    const resumedAgain = restoreTerminalTranscript(
      new ScreenManagerImpl({ sink: () => {}, stdin: null }),
      result.transcript,
      [
        { role: "user", content: "調べて" },
        { role: "assistant", content: "回答の先頭だけでなく、本来表示すべき後半も含む完全な回答です。" },
      ],
    );
    expect(resumedAgain.mode).toBe("exact");
    expect(resumedAgain.recoveredMessageCount).toBe(0);
  });

  it("Markdown描画済みの本文は欠落と誤判定して重複補完しない", () => {
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin: null });
    const result = restoreTerminalTranscript(
      screen,
      { version: 1, lines: ["見出し", "項目A", "項目B", ""], truncated: false },
      [{ role: "assistant", content: "# 見出し\n- 項目A\n- 項目B" }],
    );

    expect(result.mode).toBe("exact");
    expect(result.recoveredMessageCount).toBe(0);
  });

  it("長文の先頭だけが保存された場合は完全表示と誤認しない", () => {
    const screen = new ScreenManagerImpl({ sink: () => {}, stdin: null });
    const full = `${"先頭の内容".repeat(20)}${"中央の内容".repeat(20)}${"末尾の内容".repeat(20)}`;
    const result = restoreTerminalTranscript(
      screen,
      { version: 1, lines: [full.slice(0, 180), ""], truncated: false },
      [{ role: "assistant", content: full }],
    );

    expect(result.mode).toBe("recovered");
    expect(screen.snapshotLines().join("\n")).toContain(full);
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
