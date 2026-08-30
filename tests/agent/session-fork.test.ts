import { describe, expect, it } from "vitest";
import { forkSession, type SessionData } from "../../src/agent/session-manager.js";

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

    forked.messages.push({ role: "user", content: "分岐後だけの依頼" });
    if (forked.todos) forked.todos[0].content = "分岐後に変更";
    expect(source.messages).toHaveLength(2);
    expect(source.todos?.[0].content).toBe("続き");
  });
});
