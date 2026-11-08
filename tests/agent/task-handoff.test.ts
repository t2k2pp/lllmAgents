import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateHandoffNote } from "../../src/agent/handoff.js";
import {
  addTaskFiles,
  applyTaskHandoffUpdate,
  buildFoldedMessages,
  buildTaskPointerLine,
  collectFilesFromMessages,
  createTaskHandoffDoc,
  extractConstraintsFromHandoffNote,
  extractTaskPointerLines,
  isTaskPointerMessage,
  parseTaskHandoffUpdate,
  renderHandoffNoteFromTask,
  renderTaskHandoffExcerpt,
  renderTaskHandoffMarkdown,
  TASK_HANDOFF_LIMITS,
  TASK_POINTER_MARKER,
  TaskHandoffStore,
  type TaskHandoffUpdate,
} from "../../src/agent/task-handoff.js";
import { looksLikeContinuation, parseTaskSwitchAnswer } from "../../src/agent/task-handoff-tracker.js";
import type { Message } from "../../src/providers/base-provider.js";

/** タスクの引き継ぎ文書の純粋な部分と保存 (docs/task-handoff-design.md §4・§5・§7・§9.2) */

const empty = (): TaskHandoffUpdate => ({
  addConstraints: [],
  removeConstraints: [],
  addDecisions: [],
  addFailures: [],
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("文書の作成と描画", () => {
  it("依頼の原文は利用者の言葉をそのまま持ち、 タイトルは頭だけ", () => {
    const text = "Blender で猫を作って。\n## 見出しも入っている\n尻尾は長め";
    const doc = createTaskHandoffDoc({ sessionId: "s1", requests: [{ text }] });
    expect(doc.requests[0]).toMatchObject({ text, kind: "initial" });
    expect(doc.title.length).toBeLessThanOrEqual(TASK_HANDOFF_LIMITS.titleChars + 1);
    expect(doc.status).toBe("進行中");
    const md = renderTaskHandoffMarkdown(doc);
    for (const h of [
      "依頼の原文",
      "決まり・制約",
      "現状",
      "決めた事と理由",
      "試して駄目だった事",
      "次の一手",
      "関係するファイル",
    ]) {
      expect(md).toContain(`## ${h}`);
    }
    expect(md).toContain(text);
  });

  it("次の一手が空なら未完了の ToDo の先頭を描く", () => {
    const doc = createTaskHandoffDoc({ sessionId: "s1", requests: [{ text: "x" }] });
    doc.todos = [
      { content: "胴体", status: "completed" },
      { content: "耳を付ける", status: "pending" },
    ];
    expect(renderTaskHandoffMarkdown(doc)).toContain("(ToDo より) 耳を付ける");
  });
});

describe("更新の当てはめと上限", () => {
  it("決めた事・試して駄目だった事は上限を超えた古いものを経緯ログへ押し出す", () => {
    let doc = createTaskHandoffDoc({ sessionId: "s1", requests: [{ text: "x" }] });
    const decisions = Array.from({ length: TASK_HANDOFF_LIMITS.decisionCount + 3 }, (_, i) => `決定 ${i}`);
    const failures = Array.from({ length: TASK_HANDOFF_LIMITS.failureCount + 2 }, (_, i) => `失敗 ${i}`);
    const result = applyTaskHandoffUpdate(doc, { ...empty(), addDecisions: decisions, addFailures: failures });
    doc = result.doc;
    expect(doc.decisions).toHaveLength(TASK_HANDOFF_LIMITS.decisionCount);
    expect(doc.decisions[0]).toBe("決定 3");
    expect(doc.failures).toHaveLength(TASK_HANDOFF_LIMITS.failureCount);
    expect(result.logLines.filter((l) => l.startsWith("決めた事 (上限で経緯へ)"))).toHaveLength(3);
    expect(result.logLines.filter((l) => l.startsWith("試して駄目だった事 (上限で経緯へ)"))).toHaveLength(2);
  });

  it("決まりの削除は理由が要る (理由の無い削除は当てはめず経緯ログに残す)", () => {
    let doc = createTaskHandoffDoc({ sessionId: "s1", requests: [{ text: "x" }] });
    doc = applyTaskHandoffUpdate(doc, { ...empty(), addConstraints: ["Blender 4.2 を使う", "色は茶色"] }).doc;
    const noReason = applyTaskHandoffUpdate(doc, { ...empty(), removeConstraints: [{ text: "色は茶色", reason: "" }] });
    expect(noReason.doc.constraints).toContain("色は茶色");
    expect(noReason.logLines[0]).toContain("理由が無い");
    const withReason = applyTaskHandoffUpdate(doc, {
      ...empty(),
      removeConstraints: [{ text: "色は茶色", reason: "利用者が白に変えた" }],
    });
    expect(withReason.doc.constraints).toEqual(["Blender 4.2 を使う"]);
    expect(withReason.logLines[0]).toContain("理由: 利用者が白に変えた");
  });

  it("現状・次の一手は書き直し、 上限で切る。 長い決まりも切る", () => {
    const doc = createTaskHandoffDoc({ sessionId: "s1", requests: [{ text: "x" }] });
    const next = applyTaskHandoffUpdate(doc, {
      ...empty(),
      current: "あ".repeat(TASK_HANDOFF_LIMITS.currentChars + 100),
      next: "い".repeat(TASK_HANDOFF_LIMITS.nextChars + 100),
      addConstraints: ["う".repeat(TASK_HANDOFF_LIMITS.constraintChars + 50)],
    }).doc;
    expect(next.current.length).toBeLessThanOrEqual(TASK_HANDOFF_LIMITS.currentChars + 1);
    expect(next.next.length).toBeLessThanOrEqual(TASK_HANDOFF_LIMITS.nextChars + 1);
    expect(next.constraints[0].length).toBeLessThanOrEqual(TASK_HANDOFF_LIMITS.constraintChars + 1);
  });

  it("関係するファイルはツールの引数から拾い、 新しい順で上限まで", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "file_read", arguments: JSON.stringify({ file_path: "C:/a.py" }) },
          },
          { id: "b", type: "function", function: { name: "bash", arguments: "{壊れた JSON" } },
          {
            id: "c",
            type: "function",
            function: { name: "file_write", arguments: JSON.stringify({ path: "C:/b.py" }) },
          },
        ],
      },
    ];
    const files = collectFilesFromMessages(messages);
    expect(files).toEqual(["C:/a.py", "C:/b.py"]);
    let doc = createTaskHandoffDoc({ sessionId: "s1", requests: [{ text: "x" }] });
    doc = addTaskFiles(doc, files);
    expect(doc.files[0]).toBe("C:/b.py");
    doc = addTaskFiles(
      doc,
      Array.from({ length: 40 }, (_, i) => `C:/f${i}`),
    );
    expect(doc.files).toHaveLength(TASK_HANDOFF_LIMITS.fileCount);
    expect(doc.files[0]).toBe("C:/f39");
  });
});

describe("更新の出力の読み取り", () => {
  it("変わった節だけを読む", () => {
    const parsed = parseTaskHandoffUpdate(
      [
        "## 決まり・制約",
        "+ 尻尾は長め",
        "- 色は茶色 | 理由: 白に変えた",
        "## 現状",
        "胴体と頭まで出来た",
        "## 試して駄目だった事",
        "+ 画像生成 — API キーが無い",
        "## 次の一手",
        "耳を付ける",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.update.addConstraints).toEqual(["尻尾は長め"]);
    expect(parsed.update.removeConstraints).toEqual([{ text: "色は茶色", reason: "白に変えた" }]);
    expect(parsed.update.current).toBe("胴体と頭まで出来た");
    expect(parsed.update.addFailures).toEqual(["画像生成 — API キーが無い"]);
    expect(parsed.update.next).toBe("耳を付ける");
    expect(parsed.update.addDecisions).toEqual([]);
  });

  it("「変更なし」 は空の更新。 見出しが無ければ失敗", () => {
    const unchanged = parseTaskHandoffUpdate("変更なし");
    expect(unchanged).toMatchObject({ ok: true, unchanged: true });
    expect(parseTaskHandoffUpdate("よく分かりません").ok).toBe(false);
  });

  it("続きか別かの答えを読む / 続きの印", () => {
    expect(parseTaskSwitchAnswer('{"task":"new"}')).toBe("new");
    expect(parseTaskSwitchAnswer("same")).toBe("same");
    expect(parseTaskSwitchAnswer("たぶん")).toBeNull();
    expect(looksLikeContinuation("続けてください")).toBe(true);
    expect(looksLikeContinuation("もっと尻尾を長く")).toBe(true);
    expect(looksLikeContinuation("狼をBlenderで作って")).toBe(false);
  });
});

describe("保存と経緯ログ", () => {
  it("正本 (JSON) と読む形 (.md) をセッションの隣に書き、 読み戻せる。 経緯ログは追記だけ", () => {
    const store = new TaskHandoffStore(dir);
    const doc = createTaskHandoffDoc({ sessionId: "sess-1", requests: [{ text: "猫を作って" }] });
    const paths = store.save(doc);
    expect(paths.json).toBe(path.join(dir, "sess-1.tasks", `${doc.id}.json`));
    expect(fs.readFileSync(paths.md, "utf8")).toContain("猫を作って");
    expect(store.load(paths.json)).toEqual(doc);
    store.appendHistory(doc, ["1 回目"]);
    store.appendHistory(doc, ["2 回目"]);
    const log = fs.readFileSync(paths.history, "utf8");
    expect(log.indexOf("1 回目")).toBeLessThan(log.indexOf("2 回目"));
  });

  it("相対パスの保存先・形の違う正本は断る", () => {
    expect(() => new TaskHandoffStore("relative/dir")).toThrow(/絶対パス/);
    const store = new TaskHandoffStore(dir);
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ version: 2 }));
    expect(() => store.load(bad)).toThrow(/形が違います/);
  });
});

describe("ポインタ・抜粋・/handoff の描画", () => {
  it("畳み込みはこれまでのポインタを残して 1 行足し、 上限を超えたら古いものから落とす", () => {
    const doc = createTaskHandoffDoc({ sessionId: "s", requests: [{ text: "猫を作って" }] });
    doc.status = "中断";
    const line = buildTaskPointerLine(doc, "C:/x/t.md");
    expect(line).toBe("- 猫を作って: C:/x/t.md（中断）");
    const first = buildFoldedMessages([{ role: "user", content: "猫を作って" }], line);
    expect(first).toHaveLength(1);
    expect(isTaskPointerMessage(first[0])).toBe(true);
    expect(String(first[0].content).startsWith(TASK_POINTER_MARKER)).toBe(true);
    let raw: Message[] = first;
    for (let i = 0; i < TASK_HANDOFF_LIMITS.pointerLines + 5; i++) {
      raw = [...buildFoldedMessages(raw, `- タスク ${i}: C:/t${i}.md（完了）`), { role: "user", content: "次" }];
    }
    const lines = extractTaskPointerLines(raw);
    expect(lines).toHaveLength(TASK_HANDOFF_LIMITS.pointerLines);
    expect(lines.at(-1)).toContain(`タスク ${TASK_HANDOFF_LIMITS.pointerLines + 4}`);
  });

  it("抜粋は依頼の原文の頭と全部の節を持ち、 文書のパスを示す", () => {
    let doc = createTaskHandoffDoc({ sessionId: "s", requests: [{ text: "あ".repeat(10_000) }] });
    doc = applyTaskHandoffUpdate(doc, {
      ...empty(),
      addConstraints: ["決まり A"],
      current: "現状 B",
      next: "次 C",
    }).doc;
    const excerpt = renderTaskHandoffExcerpt(doc, "C:/t.md", 1_000);
    expect(excerpt).toContain("C:/t.md");
    expect(excerpt).toContain("決まり A");
    expect(excerpt).toContain("現状 B");
    expect(excerpt).toContain("(続きは文書)");
    expect(excerpt.length).toBeLessThan(2_500);
  });

  it("/handoff のメモは文書から描き、 既存の検証を通る。 依頼の原文はそのまま入る", () => {
    let doc = createTaskHandoffDoc({ sessionId: "s", requests: [{ text: "猫を作って\n尻尾は長め" }] });
    doc = applyTaskHandoffUpdate(doc, {
      ...empty(),
      addConstraints: ["Blender 4.2"],
      current: "胴体まで",
      addFailures: ["画像生成 — キーが無い"],
    }).doc;
    const note = renderHandoffNoteFromTask(doc, "C:/t.md");
    expect(validateHandoffNote(note)).toBe(note);
    expect(note).toContain("> 尻尾は長め");
    expect(note).toContain("C:/t.md — このタスクの引き継ぎ文書 (正本)");
    expect(note).toContain("試して駄目だった事: 画像生成 — キーが無い");
  });

  it("利用者のファイルからは「守るべき制約・決定事項」 の項目だけを拾う", () => {
    const note = "## 次にやること\n- 耳\n\n## 守るべき制約・決定事項\n- 色は白\n- なし\n\n## 関係するファイル\n- a.py";
    expect(extractConstraintsFromHandoffNote(note)).toEqual(["色は白"]);
  });
});
