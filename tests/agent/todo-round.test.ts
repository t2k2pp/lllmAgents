import { beforeEach, describe, expect, it } from "vitest";
import {
  beginTodoRound,
  clearTodos,
  formatTodos,
  getCurrentTodos,
  getTodos,
  todoAppendTool,
  todoMarkTool,
} from "../../src/tools/definitions/todo-write.js";
import { responseCompleteTool } from "../../src/tools/definitions/response-complete.js";

// ToDo を依頼ごとに区切る (docs/todo-request-elaboration.md 第 3 段 項目 15)。
// goemon ログ: 新しい依頼の todo_append 結果に前の依頼の完了済み 4 件が混ざり、
// response_complete も 8/8 と数えていた。 削除はしない (docs/todo-goal-lifecycle.md の判断を維持)。

async function append(contents: string[]): Promise<string> {
  const r = await todoAppendTool.execute({ items: contents.map((content) => ({ content, status: "pending" })) });
  return r.output;
}

async function completeAll(): Promise<void> {
  for (const t of getCurrentTodos()) await todoMarkTool.execute({ id: t.id, status: "completed" });
}

describe("ToDo の依頼ごとの区切り", () => {
  beforeEach(() => {
    clearTodos();
    beginTodoRound();
  });

  it("前の依頼で完了した項目は、 新しい依頼の todo_append 結果に出ず件数だけ添えられる", async () => {
    await append(["前の依頼の機能A", "前の依頼の機能B"]);
    await completeAll();
    beginTodoRound();
    const out = await append(["新しい依頼の機能C"]);
    expect(out).toContain("新しい依頼の機能C");
    expect(out).not.toContain("前の依頼の機能A");
    expect(out).toContain("前の依頼の完了済み 2 件は省略");
  });

  it("削除はしない (全件一覧には残る)", async () => {
    await append(["前の依頼の機能A"]);
    await completeAll();
    beginTodoRound();
    expect(getTodos()).toHaveLength(1);
    expect(formatTodos()).toContain("前の依頼の機能A");
  });

  it("未完了の項目は依頼をまたいで残り、 今の依頼で完了すれば今の依頼の項目として数える", async () => {
    await append(["続きの作業"]);
    beginTodoRound();
    expect(getCurrentTodos().map((t) => t.content)).toEqual(["続きの作業"]);
    await completeAll();
    expect(getCurrentTodos().map((t) => t.status)).toEqual(["completed"]);
  });

  it("response_complete の n/n は今の依頼の項目だけで数える", async () => {
    await append(["前A", "前B", "前C"]);
    await completeAll();
    beginTodoRound();
    await append(["今D"]);
    await completeAll();
    const r = await responseCompleteTool.execute({ summary: "done" });
    expect(r.output).toContain("(1/1 ✓)");
  });
});
