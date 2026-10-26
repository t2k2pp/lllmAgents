import { describe, it, expect } from "vitest";
import type { Message, ToolCall } from "../../src/providers/base-provider.js";
import { findToolPairingError } from "../../src/agent/message-history.js";
import {
  FAILED_RESULT_HEAD_CHARS,
  KEEP_RECENT_THINKING,
  PROTECTED_TOOL_NAMES,
  THINNED_MARKER,
  TOMBSTONE_MARKER,
  applyReductionStages,
  insertTombstone,
  estimateSentMessageTokens,
  type ReductionStagesInput,
} from "../../src/agent/reduction-stages.js";

// ─── テスト用の道具 ───

let idSeq = 0;
function call(name: string, args: Record<string, unknown> = {}, id = `c${++idSeq}`): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** 1 回の応答の組: assistant(tool_calls) + 結果 */
function batch(...pairs: Array<[ToolCall, string]>): Message[] {
  return [
    { role: "assistant", content: "", tool_calls: pairs.map(([c]) => c) },
    ...pairs.map(([c, result]) => ({ role: "tool" as const, content: result, tool_call_id: c.id })),
  ];
}

const BIG = "a".repeat(4000);
const BIG2 = "b".repeat(4000);
const user = (content: string): Message => ({ role: "user", content });

/** 末尾に置く「最新の 1 回分」 (保護される) */
function tail(): Message[] {
  return batch([call("current_datetime"), "2026-10-25"]);
}

function run(messages: Message[], overrides: Partial<ReductionStagesInput> = {}) {
  return applyReductionStages({
    messages,
    currentRequestStart: messages.length,
    keepRecentToolUses: 1,
    promptTokens: 200_000,
    goal: { targetPromptTokens: 100_000, minimumReductionTokens: 1 },
    caseInsensitivePaths: true,
    ...overrides,
  });
}

function resultOf(messages: Message[], id: string): string | undefined {
  const m = messages.find((x) => x.role === "tool" && x.tool_call_id === id);
  return m ? String(m.content) : undefined;
}

function ruleOf(result: ReturnType<typeof run>, id: string): string | undefined {
  return result.forgotten.find((f) => f.toolCallId === id)?.rule;
}

// ─── 段階 0 ───

describe("段階 0-a 読み直し", () => {
  it("後で同じファイルを同じ範囲で成功して読んだら、 前の結果を差し替えて呼び出しは残す", () => {
    const first = call("file_read", { file_path: "C:\\proj\\a.ts" });
    const second = call("file_read", { file_path: "C:\\proj\\a.ts" });
    const r = run([user("読んで"), ...batch([first, BIG]), ...batch([second, BIG2]), ...tail()], {
      keepRecentToolUses: 2,
    });
    expect(ruleOf(r, first.id)).toBe("0-a");
    expect(resultOf(r.messages, first.id)).toMatch(
      /^\[忘却済み\] file_read C:\\proj\\a\.ts の結果 .*後で読み直したため/,
    );
    expect(r.messages.some((m) => m.tool_calls?.some((c) => c.id === first.id))).toBe(true);
    // 後の読み込み (保護) はそのまま
    expect(resultOf(r.messages, second.id)).toBe(BIG2);
    expect(r.recordLines).toContain("- 後で読み直したため本文を省略: file_read×1");
  });

  it("Windows ではパスの大小文字と区切りを区別しない。 区別するときは対象にしない", () => {
    const first = call("file_read", { file_path: "C:\\Proj\\A.ts" });
    const second = call("file_read", { file_path: "c:/proj/a.ts" });
    const msgs = [...batch([first, BIG]), ...batch([second, BIG2]), ...tail()];
    expect(ruleOf(run(msgs, { keepRecentToolUses: 2 }), first.id)).toBe("0-a");
    expect(ruleOf(run(msgs, { keepRecentToolUses: 2, caseInsensitivePaths: false }), first.id)).toBe("1-result");
  });

  it("後の読み込みが狭い範囲・失敗のときは対象にしない", () => {
    const wide = call("file_read", { file_path: "/p/a.ts" });
    const narrow = call("file_read", { file_path: "/p/a.ts", offset: 10, limit: 5 });
    const failed = call("file_read", { file_path: "/p/a.ts" });
    const r = run([...batch([wide, BIG]), ...batch([narrow, BIG2]), ...batch([failed, "Error: ENOENT"]), ...tail()], {
      keepRecentToolUses: 3,
    });
    expect(ruleOf(r, wide.id)).toBe("1-result");
  });

  it("後の広い範囲の読み込みは前の狭い範囲を古くする", () => {
    const narrow = call("file_read", { file_path: "/p/a.ts", offset: 10, limit: 5 });
    const wide = call("file_read", { file_path: "/p/a.ts", offset: 1, limit: 100 });
    const r = run([...batch([narrow, BIG]), ...batch([wide, BIG2]), ...tail()], { keepRecentToolUses: 2 });
    expect(ruleOf(r, narrow.id)).toBe("0-a");
  });

  it("後で同じファイルへ file_write が成功していれば古いとみなす。 file_edit だけでは古いとみなさない", () => {
    const readW = call("file_read", { file_path: "/p/w.ts" });
    const write = call("file_write", { file_path: "/p/w.ts", content: "x" });
    const readE = call("file_read", { file_path: "/p/e.ts" });
    const edit = call("file_edit", { file_path: "/p/e.ts", old_string: "a", new_string: "b" });
    const r = run(
      [
        ...batch([readW, BIG]),
        ...batch([readE, BIG2]),
        ...batch([write, "書き込みました"], [edit, "編集しました"]),
        ...tail(),
      ],
      { keepRecentToolUses: 3 },
    );
    expect(ruleOf(r, readW.id)).toBe("0-a");
    expect(ruleOf(r, readE.id)).toBe("1-result");
  });
});

describe("段階 0-b 同じ結果", () => {
  it("後に同じツール・同じ引数 (キーの順は問わない)・全く同じ結果があれば前を差し替える", () => {
    const first = call("grep", { pattern: "foo", path: "/p" });
    const second = call("grep", { path: "/p", pattern: "foo" });
    const r = run([...batch([first, BIG]), ...batch([second, BIG]), ...tail()], { keepRecentToolUses: 2 });
    expect(ruleOf(r, first.id)).toBe("0-b");
    expect(resultOf(r.messages, first.id)).toContain("後で同じ結果を得たため");
  });

  it("結果が違えば対象にしない", () => {
    const first = call("grep", { pattern: "foo" });
    const second = call("grep", { pattern: "foo" });
    const r = run([...batch([first, BIG]), ...batch([second, BIG2]), ...tail()], { keepRecentToolUses: 2 });
    expect(ruleOf(r, first.id)).toBe("1-result");
  });
});

describe("段階 0-c 失敗のあとの成功", () => {
  it("後で同じコマンドが成功したら、 失敗の結果を先頭だけに縮め、 段階 1 でも消さない", () => {
    const failed = call("bash", { command: "npm test" });
    const ok = call("bash", { command: "npm test" });
    const errorText = `Error: exit 1\n${"e".repeat(3000)}`;
    const r = run([...batch([failed, errorText]), ...batch([ok, "passed"]), ...tail()], { keepRecentToolUses: 2 });
    expect(ruleOf(r, failed.id)).toBe("0-c");
    const text = resultOf(r.messages, failed.id) ?? "";
    expect(text.startsWith(errorText.slice(0, FAILED_RESULT_HEAD_CHARS))).toBe(true);
    expect(text).toContain(`\n${THINNED_MARKER} 以降`);
    expect(r.forgotten.filter((f) => f.toolCallId === failed.id)).toHaveLength(1);
  });

  it("file_edit の対象はパス。 別のパスの成功では対象にしない", () => {
    const failed = call("file_edit", { file_path: "/p/a.ts", old_string: "x", new_string: "y" });
    const okOther = call("file_edit", { file_path: "/p/b.ts", old_string: "x", new_string: "y" });
    const r = run([...batch([failed, `Error: not found\n${BIG}`]), ...batch([okOther, "ok"]), ...tail()], {
      keepRecentToolUses: 2,
    });
    expect(ruleOf(r, failed.id)).toBe("1-result");
  });
});

describe("段階 0-d 上書きされた書き込み", () => {
  it("後で同じファイルへの file_write が成功していれば、 前の対を外して 1 行の記録にする", () => {
    const first = call("file_write", { file_path: "/p/app.js", content: BIG });
    const second = call("file_write", { file_path: "/p/app.js", content: BIG2 });
    const r = run([user("作って"), ...batch([first, "ok"]), ...batch([second, "ok"]), ...tail()], {
      keepRecentToolUses: 2,
    });
    expect(ruleOf(r, first.id)).toBe("0-d");
    expect(r.messages.some((m) => m.tool_calls?.some((c) => c.id === first.id) || m.tool_call_id === first.id)).toBe(
      false,
    );
    expect(r.recordLines.join("\n")).toMatch(
      /file_write \/p\/app\.js \(引数 約 [\d,]+ \/ 結果 約 \d+ トークン\) \(後で同じファイルに書き直し\)/,
    );
  });

  it("後の書き込みが失敗なら 0-d にしない (本文ありなので段階 1 が対ごと外す)", () => {
    const first = call("file_write", { file_path: "/p/app.js", content: BIG });
    const second = call("file_write", { file_path: "/p/app.js", content: BIG2 });
    const r = run([...batch([first, "ok"]), ...batch([second, "Error: EACCES"]), ...tail()], { keepRecentToolUses: 2 });
    expect(ruleOf(r, first.id)).toBe("1-pair");
  });
});

describe("段階 0 の慎重側の規則", () => {
  it("最新の 1 回分の応答の組は K が 0 でも古い側として扱わない", () => {
    const first = call("grep", { pattern: "foo" });
    const latest = call("grep", { pattern: "foo" });
    const r = run([...batch([first, BIG]), ...batch([latest, BIG])], { keepRecentToolUses: 0 });
    expect(ruleOf(r, first.id)).toBe("0-b");
    expect(resultOf(r.messages, latest.id)).toBe(BIG);
  });

  it("結果の本文が文字列でないもの・既に消したものは判定せず、 手本にもしない", () => {
    const first = call("grep", { pattern: "foo" });
    const second = call("grep", { pattern: "foo" });
    const thinned = `${THINNED_MARKER} grep foo の結果 (約 10 トークン) は履歴から削除しました。`;
    const r = run([...batch([first, thinned]), ...batch([second, thinned]), ...tail()], { keepRecentToolUses: 2 });
    expect(r.forgotten).toHaveLength(0);
  });
});

// ─── 段階 1 ───

describe("段階 1 古いツール結果を消す", () => {
  it("保護されていない結果の本文を差し替え、 呼び出しは残す (書き込み・実行系も対象)", () => {
    const b = call("bash", { command: "ls" });
    const r = run([...batch([b, BIG]), ...tail()]);
    expect(ruleOf(r, b.id)).toBe("1-result");
    expect(resultOf(r.messages, b.id)).toMatch(
      /^\[忘却済み\] bash ls の結果 \(約 [\d,]+ トークン\) は履歴から削除しました/,
    );
    expect(r.recordLines).toContain("- 本文のみ削除 (行動の記録は残存): bash×1");
  });

  it("本文ありの呼び出しは対ごと外し、 引数の切れ端を呼び出しの形で残さない", () => {
    const longCommand = `git commit -m "${"feat ".repeat(80)}"`;
    const bulky = call("bash", { command: longCommand });
    const small = call("file_read", { file_path: "/p/x.ts" });
    const r = run([...batch([bulky, "committed"], [small, BIG]), ...tail()]);
    expect(ruleOf(r, bulky.id)).toBe("1-pair");
    expect(ruleOf(r, small.id)).toBe("1-result");
    const head = r.messages.find((m) => m.tool_calls?.some((c) => c.id === small.id));
    expect(head?.tool_calls?.map((c) => c.id)).toEqual([small.id]);
    expect(JSON.stringify(r.messages)).not.toContain("feat feat");
    expect(r.recordLines.join("\n")).toContain("- 実行済み (呼び出しと結果の本文は削除):");
  });

  it("旧方式で切り詰めた引数 ([忘却済み] を含む) も本文ありとして対ごと外す", () => {
    const old = call("bash", {
      command: `cd /c/app && git commit -m "x\n${THINNED_MARKER} 以降 約 300 トークンを削除`,
    });
    const r = run([...batch([old, `${THINNED_MARKER} bash の結果は履歴から削除しました。`]), ...tail()]);
    expect(ruleOf(r, old.id)).toBe("1-pair");
  });

  it("差し替え済みの結果は再変換せず、 減る量が 0 以下のものは選ばない (同じ参照のまま)", () => {
    const thinned = call("file_read", { file_path: "/p/a.ts" });
    const tiny = call("bash", { command: "pwd" });
    const msgs = [
      ...batch([thinned, `${THINNED_MARKER} file_read /p/a.ts の結果 (約 1,000 トークン) は履歴から削除しました。`]),
      ...batch([tiny, "/p"]),
      ...tail(),
    ];
    const r = run(msgs);
    expect(r.forgotten).toHaveLength(0);
    expect(r.recordLines).toEqual([]);
    expect(r.firstForgottenIndex).toBeNull();
    for (const [i, m] of r.messages.entries()) expect(m).toBe(msgs[i]);
  });

  it("呼び出しが全部外れて本文も無い assistant は消える。 本文があれば本文だけ残す", () => {
    const a = call("file_write", { file_path: "/p/a", content: BIG });
    const b = call("file_write", { file_path: "/p/b", content: BIG });
    const msgs: Message[] = [
      ...batch([a, "ok"]),
      { role: "assistant", content: "b を書きます", tool_calls: [b] },
      { role: "tool", content: "ok", tool_call_id: b.id },
      ...tail(),
    ];
    const r = run(msgs);
    expect(r.messages[0]).toEqual({ role: "assistant", content: "b を書きます" });
    expect(r.messages).toHaveLength(1 + 2);
  });
});

// ─── 段階 2 と前処理 ───

describe("段階 2 今の依頼の思考", () => {
  it("今の依頼の思考を古い順に消し、 直近 3 件は残す", () => {
    const msgs: Message[] = [user("依頼")];
    for (let i = 0; i < 5; i++) msgs.push({ role: "assistant", content: `途中 ${i}`, thinking: `考え ${i} ${BIG}` });
    const r = run(msgs, { currentRequestStart: 0 });
    const thinking = r.messages.map((m) => m.thinking);
    expect(thinking.filter(Boolean)).toHaveLength(KEEP_RECENT_THINKING);
    expect(thinking.slice(1, 3)).toEqual([undefined, undefined]);
    expect(r.clearedCurrentThinking).toBe(2);
    expect(r.repaid.thinking).toBe(0);
    expect(r.freedTokens.stage2).toBeGreaterThan(0);
    expect(r.recordLines).toContain("- 今の依頼の古い思考: 2 件を削除");
  });
});

describe("前処理 (借りの返済)", () => {
  it("終わった依頼の揮発メッセージを除き思考を消す。 今の依頼の揮発メッセージは残す", () => {
    const nudgeOld: Message = { role: "user", content: "点検してください (ハーネス)", ephemeral: true };
    const nudgeNow: Message = { role: "user", content: "続けてください (ハーネス)", ephemeral: true };
    const msgs: Message[] = [
      user("前の依頼"),
      { role: "assistant", content: "前の答え", thinking: BIG },
      nudgeOld,
      user("今の依頼"),
      nudgeNow,
      { role: "assistant", content: "今の途中", thinking: "今の考え" },
    ];
    const r = run(msgs, { currentRequestStart: 3 });
    expect(r.messages).not.toContain(nudgeOld);
    expect(r.messages).toContain(nudgeNow);
    expect(r.messages[1]).toEqual({ role: "assistant", content: "前の答え" });
    expect(r.messages.at(-1)?.thinking).toBe("今の考え");
    expect(r.repaid).toEqual({ ephemeral: 1, thinking: 1 });
    expect(r.freedTokens.preprocess).toBeGreaterThan(0);
    // 前処理は忘却の記録の行にしない (件数は repaid で返す)
    expect(r.recordLines).toEqual([]);
  });
});

// ─── 保護 ───

describe("保護するもの", () => {
  it("system ノート・利用者の発言・保護するツール・直近 K 回には触れない", () => {
    const note: Message = { role: "system", content: `[忘却の記録] ${BIG}` };
    const summary: Message = { role: "system", content: `[会話履歴の要約]\n${BIG}` };
    const longUser = user(BIG);
    const ask = call("ask_user", { question: "どちらにしますか" });
    const todo = call("todo_mark", { id: 1, status: "completed" });
    const plan = call("exit_plan_mode", { plan_content: BIG });
    const old = call("file_read", { file_path: "/p/old.ts" });
    const recent1 = call("file_read", { file_path: "/p/r1.ts" });
    const recent2 = call("file_read", { file_path: "/p/r2.ts" });
    const msgs: Message[] = [
      summary,
      longUser,
      ...batch([ask, `回答: ${BIG}`], [todo, BIG], [plan, "承認"]),
      note,
      ...batch([old, BIG]),
      ...batch([recent1, BIG]),
      ...batch([recent2, BIG]),
    ];
    const r = run(msgs, { keepRecentToolUses: 2 });
    expect(r.forgotten.map((f) => f.toolCallId)).toEqual([old.id]);
    for (const kept of [summary, longUser, note]) expect(r.messages).toContain(kept);
    for (const id of [ask.id, todo.id, plan.id, recent1.id, recent2.id]) {
      expect(resultOf(r.messages, id)).toBe(resultOf(msgs, id));
    }
    expect(r.messages.find((m) => m.tool_calls?.some((c) => c.id === plan.id))).toBe(msgs[2]);
  });

  it("保護するツールの一覧", () => {
    expect([...PROTECTED_TOOL_NAMES].sort()).toEqual(
      [
        "ask_user",
        "enter_plan_mode",
        "exit_plan_mode",
        "response_complete",
        "todo_append",
        "todo_delete",
        "todo_mark",
      ].sort(),
    );
  });
});

// ─── 対の検証・純粋さ・停止条件 ───

function mixedHistory(): Message[] {
  const w1 = call("file_write", { file_path: "/p/a.js", content: BIG });
  const w2 = call("file_write", { file_path: "/p/a.js", content: BIG2 });
  const r1 = call("file_read", { file_path: "/p/a.js" });
  const r2 = call("file_read", { file_path: "/p/a.js" });
  const e1 = call("bash", { command: "npm test" });
  const e2 = call("bash", { command: "npm test" });
  const bulky = call("bash", { command: "x".repeat(500) });
  return [
    { role: "system", content: "[会話履歴の要約]\n前の話" },
    user("前の依頼"),
    { role: "assistant", content: "", thinking: BIG, tool_calls: [w1, r1] },
    { role: "tool", content: "ok", tool_call_id: w1.id },
    { role: "tool", content: BIG, tool_call_id: r1.id },
    { role: "assistant", content: "前の答え", thinking: BIG2 },
    user("今の依頼"),
    ...batch([e1, `Error: fail\n${BIG}`], [bulky, BIG]),
    { role: "assistant", content: "", thinking: "t1", tool_calls: [w2] },
    { role: "tool", content: "ok", tool_call_id: w2.id, contextNote: "# Current datetime\nx" },
    ...batch([r2, BIG2]),
    ...batch([e2, "passed"]),
  ];
}

describe("ツールの対の検証", () => {
  it("片方だけの呼び出し・結果を見つける", () => {
    const c = call("bash", { command: "ls" });
    expect(findToolPairingError([{ role: "tool", content: "x", tool_call_id: "zz" }])).toMatch(/孤立/);
    expect(findToolPairingError([{ role: "assistant", content: "", tool_calls: [c] }])).toMatch(/欠落/);
    expect(findToolPairingError(batch([c, "ok"]))).toBeNull();
  });

  it("変換後の写しは必ず検証を通る。 忘却の記録を最初に消した位置に挟んでも対は壊れない", () => {
    const r = run(mixedHistory(), { currentRequestStart: 6, keepRecentToolUses: 3 });
    expect(findToolPairingError(r.messages)).toBeNull();
    expect(r.forgotten.map((f) => f.rule).sort()).toEqual(["0-a", "0-c", "0-d", "1-pair"].sort());
    expect(r.firstForgottenIndex).not.toBeNull();
    const at = r.firstForgottenIndex ?? 0;
    const withNote = [
      ...r.messages.slice(0, at),
      { role: "system" as const, content: "[忘却の記録]" },
      ...r.messages.slice(at),
    ];
    expect(findToolPairingError(withNote)).toBeNull();
  });
});

describe("1 つの応答の中の一部の呼び出しだけを外す・差し替える (§5.4)", () => {
  it("保護と非保護が混ざる応答: 非保護の本文ありは対ごと外し、 他は結果だけ差し替え、 保護は触らない。 順と対は保つ", () => {
    const bulky = call("bash", { command: `f=data/e.txt ${"x".repeat(400)}` });
    const read = call("file_read", { file_path: "/p/a.txt" });
    const todos = [1, 2, 3].map((i) => call("todo_append", { items: [{ content: `項目 ${i}` }] }));
    const msgs: Message[] = [
      user("依頼"),
      {
        role: "assistant",
        content: "",
        tool_calls: [bulky, todos[0], read, todos[1], todos[2]],
      },
      { role: "tool", content: `Error: Exit code: 127\n${BIG}`, tool_call_id: bulky.id },
      { role: "tool", content: "1 項目を追加しました。", tool_call_id: todos[0].id },
      { role: "tool", content: BIG, tool_call_id: read.id },
      { role: "tool", content: "1 項目を追加しました。", tool_call_id: todos[1].id },
      { role: "tool", content: "1 項目を追加しました。", tool_call_id: todos[2].id },
      ...tail(),
    ];
    const r = run(msgs);
    expect(findToolPairingError(r.messages)).toBeNull();
    const head = r.messages[1];
    expect(head.tool_calls?.map((c) => c.id)).toEqual([todos[0].id, read.id, todos[1].id, todos[2].id]);
    expect(r.messages.slice(2, 6).map((m) => m.tool_call_id)).toEqual([todos[0].id, read.id, todos[1].id, todos[2].id]);
    expect(ruleOf(r, bulky.id)).toBe("1-pair");
    expect(ruleOf(r, read.id)).toBe("1-result");
    for (const t of todos) expect(resultOf(r.messages, t.id)).toBe("1 項目を追加しました。");
    expect(r.messages).toHaveLength(msgs.length - 1);
  });

  it("全部の呼び出しを外したら、 本文か思考があれば本文 (と思考) だけの assistant として残し、 無ければ assistant ごと消す", () => {
    const a = call("bash", { command: "y".repeat(400) });
    const b = call("bash", { command: "z".repeat(400) });
    const c = call("bash", { command: "w".repeat(400) });
    const msgs: Message[] = [
      user("前の依頼"),
      ...batch([a, "ok"], [b, "ok"]),
      user("今の依頼"),
      { role: "assistant", content: "", thinking: "考え", tool_calls: [c] },
      { role: "tool", content: "ok", tool_call_id: c.id },
      ...tail(),
    ];
    const r = run(msgs, { currentRequestStart: 4 });
    expect(findToolPairingError(r.messages)).toBeNull();
    // 前の依頼の応答 (本文も思考も無い) は消える。 今の依頼の応答は思考だけの assistant になる
    expect(r.messages[1]).toBe(msgs[4]);
    expect(r.messages[2]).toEqual({ role: "assistant", content: "", thinking: "考え" });
    expect(r.forgotten.map((f) => f.toolCallId)).toEqual([a.id, b.id, c.id]);
  });
});

describe("実機 2026-10-26 の再現: 397 件の呼び出しの応答の結果の途中に、 ハーネスの促しが挟まった履歴", () => {
  /**
   * 保存セッション mvp5t7u6-8yb2 の形を小さくしたもの: bash 2 件 (1 件は本文あり) + todo_append (保護) の応答で、
   * 計画/Todo 過多の促し (揮発の user) が 6 件目の todo_append の結果の後に入っていた。
   */
  function interleaved(): { messages: Message[]; requestStart: number } {
    const bash1 = call("bash", { command: `f=data/d.txt; ${"Hmm ".repeat(80)}` });
    const bash2 = call("bash", { command: "f=data/e.txt? ..." });
    const todos = Array.from({ length: 10 }, (_, i) => call("todo_append", { items: [{ content: `Read ${i}` }] }));
    const calls = [bash1, bash2, ...todos];
    const results: Message[] = calls.map((c, i) => ({
      role: "tool",
      content: i < 2 ? "Error: Exit code: 127" : "2 項目を追加しました。",
      tool_call_id: c.id,
    }));
    const nudge: Message = { role: "user", content: "[ハーネス] 計画/Todo の更新が過多です", ephemeral: true };
    const messages: Message[] = [
      user("data/a.txt を読んで"),
      ...batch([call("file_read", { file_path: "data/a.txt" }), BIG]),
      { role: "assistant", content: "65 個です。" },
      user("data/b.txt を読んで"),
      { role: "assistant", content: "", tool_calls: calls },
      ...results.slice(0, 8),
      nudge,
      ...results.slice(8),
    ];
    return { messages, requestStart: 4 };
  }

  it("依頼の途中で整理すると対が壊れたまま: 「整理前の履歴」 が壊れていると報告する (変換で壊したとは言わない)", () => {
    const { messages, requestStart } = interleaved();
    expect(findToolPairingError(messages)).toMatch(/tool_result が欠落しています \(assistant index=5/);
    expect(() => run(messages, { currentRequestStart: requestStart })).toThrow(
      /整理前の履歴のツールの対が既に壊れていて、 段階 0〜2 の後も壊れたままです: tool_result が欠落しています/,
    );
  });

  it("依頼の終わりの整理では、 前処理が終わった依頼の促しを除くので対が揃い、 正しい写しを返す (実機の r-2 と同じ)", () => {
    const { messages } = interleaved();
    const r = run(messages, { currentRequestStart: messages.length, keepRecentToolUses: 5 });
    expect(findToolPairingError(r.messages)).toBeNull();
    expect(r.repaid.ephemeral).toBe(1);
  });

  it("促しが結果の後ろにあれば (AgentLoop の修正後の形)、 段階 0〜2 を当てても対は保たれる", () => {
    const { messages, requestStart } = interleaved();
    const nudgeAt = messages.findIndex((m) => m.ephemeral);
    const fixed = [...messages.slice(0, nudgeAt), ...messages.slice(nudgeAt + 1), messages[nudgeAt]];
    expect(findToolPairingError(fixed)).toBeNull();
    for (const start of [requestStart, fixed.length]) {
      const r = run(fixed, { currentRequestStart: start, keepRecentToolUses: 5 });
      expect(findToolPairingError(r.messages)).toBeNull();
    }
  });
});

describe("純粋さと減った量", () => {
  it("入力の配列もメッセージも書き換えない", () => {
    const msgs = mixedHistory();
    msgs[5] = { ...msgs[5], ephemeral: true };
    const snapshot = structuredClone(msgs);
    run(msgs, { currentRequestStart: 6 });
    expect(msgs).toEqual(snapshot);
  });

  it("段階ごとの減った量の合計は送る形の推定の差に等しく、 整理後の P は整理前の P から引いた値", () => {
    const msgs = mixedHistory();
    const r = run(msgs, { currentRequestStart: 6, promptTokens: 150_000 });
    const f = r.freedTokens;
    expect(f.preprocess + f.stage0 + f.stage1 + f.stage2).toBe(f.total);
    expect(f.total).toBe(estimateSentMessageTokens(msgs) - estimateSentMessageTokens(r.messages));
    expect(f.preprocess).toBeGreaterThan(0);
    expect(f.stage0).toBeGreaterThan(0);
    expect(f.stage1).toBeGreaterThan(0);
    expect(r.promptTokensAfter).toBe(150_000 - f.total);
  });

  it("段階 2 の後に目標と最低量を満たせば段階 3 は要らない。 どちらかが足りなければ要る", () => {
    const msgs = mixedHistory();
    const ok = run(msgs, { promptTokens: 50_000, goal: { targetPromptTokens: 49_000, minimumReductionTokens: 100 } });
    expect(ok.needsSummary).toBe(false);
    expect(ok.shortfall).toEqual({ toTarget: 0, toMinimum: 0 });

    const overTarget = run(msgs, {
      promptTokens: 500_000,
      goal: { targetPromptTokens: 100_000, minimumReductionTokens: 1 },
    });
    expect(overTarget.needsSummary).toBe(true);
    expect(overTarget.shortfall.toTarget).toBe(overTarget.promptTokensAfter - 100_000);

    const underMinimum = run(msgs, {
      promptTokens: 50_000,
      goal: { targetPromptTokens: 49_000, minimumReductionTokens: 10_000_000 },
    });
    expect(underMinimum.needsSummary).toBe(true);
    expect(underMinimum.shortfall.toMinimum).toBe(10_000_000 - underMinimum.freedTokens.total);
  });
});

describe("忘却の記録 (insertTombstone) — 黙った欠損を作らない", () => {
  it("既存の記録があれば追記して 1 件にまとめ、 履歴の中に散らばらない", () => {
    const base: Message[] = [
      { role: "system", content: `${TOMBSTONE_MARKER} 1 回目` },
      { role: "user", content: "u" },
    ];
    const merged = insertTombstone(base, `${TOMBSTONE_MARKER} 2 回目`, 1);
    expect(merged.filter((m) => String(m.content).startsWith(TOMBSTONE_MARKER)).length).toBe(1);
    expect(String(merged[0].content)).toContain("1 回目");
    expect(String(merged[0].content)).toContain("2 回目");
    expect(merged.length).toBe(2);
  });

  it("無ければ指定の位置に 1 件入れる", () => {
    const base: Message[] = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    const out = insertTombstone(base, "T", 1);
    expect(out.map((m) => m.content)).toEqual(["a", "T", "b"]);
  });
});
