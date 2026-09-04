import { describe, expect, it } from "vitest";
import {
  appendSessionTerminalOutput,
  forkSession,
  normalizeSessionTitle,
  type SessionData,
} from "../../src/agent/session-manager.js";

describe("forkSession", () => {
  it("元セッションを変更せず、履歴・todo・goalを独立コピーして系譜を残す", () => {
    const source: SessionData = {
      meta: {
        id: "source-id",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        model: "test-model",
        messageCount: 2,
        title: "元の会話",
        room: "B",
      },
      messages: [
        { role: "user", content: "最初の依頼" },
        { role: "assistant", content: "最初の回答" },
      ],
      todos: [{ id: "todo-1", content: "続き", status: "pending", createdAt: "2026-01-01T00:00:00.000Z" }],
      goal: null,
      runCheckpoint: { schemaVersion: 1, state: "durable_paused" },
      terminalTranscript: { version: 1, lines: ["> 最初の依頼", "最初の回答", ""], truncated: false },
    };

    const forked = forkSession(source);

    expect(forked.meta.id).not.toBe(source.meta.id);
    expect(forked.meta.forkedFrom).toBe(source.meta.id);
    expect(forked.meta.room).toBe("B");
    expect(forked.meta.title).toBe("元の会話 (fork)");
    expect(forked.meta.messageCount).toBe(2);
    expect(forked.messages).toEqual(source.messages);
    expect(forked.messages).not.toBe(source.messages);
    expect(forked.todos).not.toBe(source.todos);
    expect(forked.runCheckpoint).toBeUndefined();
    expect(forked.terminalTranscript).toEqual(source.terminalTranscript);
    expect(forked.terminalTranscript).not.toBe(source.terminalTranscript);

    forked.messages.push({ role: "user", content: "分岐後だけの依頼" });
    if (forked.todos) forked.todos[0].content = "分岐後に変更";
    expect(source.messages).toHaveLength(2);
    expect(source.todos?.[0].content).toBe("続き");
  });
});

describe("appendSessionTerminalOutput", () => {
  it("分割writeを同じ行へ結合し、改行後の書きかけ行も保持する", () => {
    let transcript = appendSessionTerminalOutput(undefined, "hel");
    transcript = appendSessionTerminalOutput(transcript, "lo\n次");
    expect(transcript).toEqual({ version: 1, lines: ["hello", "次"], truncated: false });
  });
});

describe("normalizeSessionTitle", () => {
  it("control/format文字を可視spaceへ変換し、空白を整理する", () => {
    expect(normalizeSessionTitle("  release\u0000\n\u200breadiness  ")).toBe("release readiness");
  });

  it("可視文字がない名前を拒否する", () => {
    expect(() => normalizeSessionTitle("\u0000\u200b\n")).toThrow(/空/);
    expect(() => normalizeSessionTitle("\u200c\u200d")).toThrow(/空/);
  });

  it("保存済み一覧で扱える80文字に制限する", () => {
    expect(normalizeSessionTitle("a".repeat(81))).toHaveLength(80);
    expect(normalizeSessionTitle("👨‍👩‍👧‍👦".repeat(81))).toBe("👨‍👩‍👧‍👦".repeat(80));
  });
});
