import { describe, it, expect } from "vitest";
import { MessageHistory } from "../../src/agent/message-history.js";

function toolCall(id: string, name: string) {
  return { id, type: "function" as const, function: { name, arguments: "{}" } };
}

describe("MessageHistory.replaceMessages — ペア整合を検証して壊れた履歴を弾く", () => {
  it("整合していれば置き換わる", () => {
    const h = new MessageHistory("sys");
    h.replaceMessages([
      { role: "user", content: "u" },
      { role: "assistant", content: "x", tool_calls: [toolCall("c1", "f")] },
      { role: "tool", content: "r", tool_call_id: "c1" },
    ]);
    expect(h.getRawMessages().length).toBe(3);
  });

  it("tool_calls に対応する tool_result が欠けていたら throw", () => {
    const h = new MessageHistory("sys");
    expect(() =>
      h.replaceMessages([
        { role: "assistant", content: "x", tool_calls: [toolCall("c1", "f")] },
        { role: "user", content: "u" },
      ]),
    ).toThrow(/tool_result が欠落/);
  });

  it("孤立した tool_result は throw", () => {
    const h = new MessageHistory("sys");
    expect(() => h.replaceMessages([{ role: "tool", content: "r", tool_call_id: "c1" }])).toThrow(/孤立/);
  });

  it("tool_call_id が対応しない tool_result は throw", () => {
    const h = new MessageHistory("sys");
    expect(() =>
      h.replaceMessages([
        { role: "assistant", content: "x", tool_calls: [toolCall("c1", "f")] },
        { role: "tool", content: "r", tool_call_id: "別の id" },
      ]),
    ).toThrow(/対応する tool_call の無い/);
  });

  it("throw した場合、 履歴は書き換わらず、 書き換えの回数も進まない", () => {
    const h = new MessageHistory("sys");
    h.replaceMessages([{ role: "user", content: "u" }]);
    const before = h.getRawMessages();
    const revision = h.getRevision();
    expect(() => h.replaceMessages([{ role: "tool", content: "orphan", tool_call_id: "zz" }])).toThrow();
    expect(h.getRawMessages()).toEqual(before);
    expect(h.getRevision()).toBe(revision);
  });
});

describe("MessageHistory — 揮発の印 (Message.ephemeral。 docs/context-reduction-redesign.md §6.2)", () => {
  it("ephemeral=true のメッセージに印が付き、 永続メッセージには付かない", () => {
    const history = new MessageHistory("system");
    history.addUserMessage("U1 (永続: ユーザー実発話)");
    history.addAssistantMessage("A1 (永続: 最終応答相当)");
    history.addUserMessage("[ハーネス] nudge", { ephemeral: true });
    history.addAssistantMessage("（空のレスポンス）", undefined, { ephemeral: true });
    expect(history.getRawMessages().map((m) => m.ephemeral === true)).toEqual([false, false, true, true]);
  });

  it("tool_call を含む assistant メッセージは ephemeral=true でも揮発化されない (tool ペア保護)", () => {
    const history = new MessageHistory("system");
    // 警告ログを抑止するため一時的に console.warn をモック
    const origWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]): void => {
      warnings.push(args);
    };
    try {
      history.addAssistantMessage(
        "tool 呼び出しを含む応答",
        [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
        { ephemeral: true },
      );
      history.addToolResult("call_1", "結果");
      expect(history.getRawMessages()[0].ephemeral).toBeUndefined();
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = origWarn;
    }
  });

  it("表示済み (displayed=true) の応答は揮発として渡されても印を付けない (会話記録として残す)", () => {
    // 2026-06-12 の実害: 会話リクエストの実回答 (表示済みテキスト) が self-check 経路で
    // 揮発になり、 除かれてモデルが自分の回答を参照できなくなった
    const history = new MessageHistory("system");
    history.addUserMessage("感動する四字熟語ベスト10を教えて");
    history.addAssistantMessage("1. 一期一会 …", undefined, { ephemeral: true, displayed: true });
    history.addAssistantMessage("（空のレスポンス）", undefined, { ephemeral: true, displayed: false });
    const raw = history.getRawMessages();
    expect(raw[1].ephemeral).toBeUndefined();
    expect(raw[2].ephemeral).toBe(true);
  });

  it("応答の終わりの片付けは無い: 印の付いたメッセージも履歴に残り、 書き換え理由も出ない", () => {
    const history = new MessageHistory("sys");
    history.addUserMessage("U1");
    history.addUserMessage("[ハーネス] nudge", { ephemeral: true });
    history.addAssistantMessage("答え", undefined, { thinking: "考え" });
    expect(history.getRawMessages()).toHaveLength(3);
    expect(history.takeRewriteReasons()).toEqual([]);
    expect(history.getRevision()).toBe(0);
  });

  it("provider 用の getMessages() には揮発の印が載らない (provider にリークしない)", () => {
    const history = new MessageHistory("sys");
    history.addUserMessage("U1");
    history.addUserMessage("[ハーネス] nudge", { ephemeral: true });
    history.addAssistantMessage("（空）", undefined, { ephemeral: true, thinking: "考え" });
    history.attachDynamicContext();
    history.addUserMessage("[ハーネス] 2 つ目", { ephemeral: true });
    history.attachDynamicContext(); // 揮発の user に状態通知が付く (contextNote の描画の分岐)
    const all = history.getMessages();
    expect(all.map((m) => m.content)).toHaveLength(5);
    for (const m of all) expect(m).not.toHaveProperty("ephemeral");
    expect(all[4].content as string).toContain("<harness-context>");
    // 内部の履歴には残っている
    expect(history.getRawMessages().filter((m) => m.ephemeral).length).toBe(3);
  });

  it("印はメッセージの欄なので JSON にして戻しても失われない (セッションの保存・再開)", () => {
    const history = new MessageHistory("sys");
    history.addUserMessage("[ハーネス] nudge", { ephemeral: true });
    const restored = JSON.parse(JSON.stringify(history.getRawMessages()));
    expect(restored[0].ephemeral).toBe(true);
  });
});

describe("MessageHistory — 前方一致の安定化 (docs/prompt-prefix-stability.md)", () => {
  const callA = [{ id: "call_a", type: "function" as const, function: { name: "f", arguments: "{}" } }];
  const callB = [{ id: "call_b", type: "function" as const, function: { name: "f", arguments: "{}" } }];
  const T0 = new Date(2026, 9, 25, 10, 0, 0);
  const T1 = new Date(2026, 9, 25, 10, 5, 0);

  function withState(state: { value: string }): MessageHistory {
    const h = new MessageHistory("BASE");
    h.setSystemPromptComposer((base) => ({ stable: base, dynamic: state.value }));
    return h;
  }

  it("composer 未設定なら system は 1 メッセージ (後方互換)", () => {
    const h = new MessageHistory("BASE");
    h.addUserMessage("U1");
    const msgs = h.getMessages();
    expect(msgs.filter((m) => m.role === "system").length).toBe(1);
    expect(msgs[0].content).toBe("BASE");
  });

  it("dynamic は履歴より前の system に入らない (system は stable の 1 通だけ)", () => {
    const h = withState({ value: "TODO-1" });
    h.addUserMessage("U1");
    const sys = h.getMessages().filter((m) => m.role === "system");
    expect(sys.length).toBe(1);
    expect(sys[0].content).toBe("BASE");
  });

  it("新しい user メッセージには日時と状態を添付し、 本文の後ろに描画する", () => {
    const h = withState({ value: "TODO-1" });
    h.addUserMessage("U1");
    expect(h.attachDynamicContext(T0)).toBe(true);
    const last = h.getMessages().at(-1);
    expect(typeof last?.content).toBe("string");
    const text = last?.content as string;
    expect(text.startsWith("U1\n\n<harness-context>")).toBe(true);
    expect(text).toContain("# Current datetime");
    expect(text).toContain("TODO-1");
    expect(last).not.toHaveProperty("contextNote"); // provider に内部フィールドを渡さない
    // ユーザー発言の判定用の raw は本文のまま
    expect(h.getRawMessages().at(-1)?.content).toBe("U1");
  });

  it("状態が変わらない間は tool 結果に添付せず、 前回送った部分は 1 文字も変わらない", () => {
    const state = { value: "TODO-1" };
    const h = withState(state);
    h.addUserMessage("U1");
    h.attachDynamicContext(T0);
    const first = JSON.stringify(h.getMessages());
    h.addAssistantMessage("", callA);
    h.addToolResult("call_a", "R1");
    expect(h.attachDynamicContext(T1)).toBe(false);
    const second = JSON.stringify(h.getMessages());
    expect(second.startsWith(first.slice(0, -1))).toBe(true); // 末尾 "]" を除いて前方一致
  });

  it("状態が変わったら末尾の tool 結果に添付し、 過去の通知は書き換えない", () => {
    const state = { value: "TODO-1" };
    const h = withState(state);
    h.addUserMessage("U1");
    h.attachDynamicContext(T0);
    const userRendered = JSON.stringify(h.getMessages()[1]);
    h.addAssistantMessage("", callA);
    h.addToolResult("call_a", "R1");
    state.value = "TODO-2";
    expect(h.attachDynamicContext(T1)).toBe(true);
    const msgs = h.getMessages();
    expect(JSON.stringify(msgs[1])).toBe(userRendered);
    expect(msgs.at(-1)?.content as string).toContain("TODO-2");
  });

  it("送信済みのメッセージには添付しない (接続リトライで同じ履歴を再送する場合)", () => {
    const state = { value: "TODO-1" };
    const h = withState(state);
    h.addUserMessage("U1");
    h.attachDynamicContext(T0);
    h.addAssistantMessage("", callA);
    h.addToolResult("call_a", "R1");
    h.attachDynamicContext(T1); // 送信 (状態不変なので添付なし)
    const sent = JSON.stringify(h.getMessages());
    state.value = "TODO-2";
    expect(h.attachDynamicContext(T1)).toBe(false); // 再送: 末尾は送信済み
    expect(JSON.stringify(h.getMessages())).toBe(sent);
    // 次の新しいメッセージで反映される
    h.addAssistantMessage("", callB);
    h.addToolResult("call_b", "R2");
    expect(h.attachDynamicContext(T1)).toBe(true);
    expect(h.getMessages().at(-1)?.content as string).toContain("TODO-2");
  });

  it("前回通知を付けたメッセージが消えたら (整理・圧縮など) 状態を出し直す", () => {
    const h = withState({ value: "TODO-1" });
    h.addUserMessage("nudge", { ephemeral: true });
    h.attachDynamicContext(T0);
    h.replaceMessages([], "reduction:r-test"); // 整理イベントで揮発の促しが消えた
    h.addUserMessage("U2");
    h.attachDynamicContext(T1);
    h.addAssistantMessage("", callA);
    h.addToolResult("call_a", "R1");
    h.replaceMessages(h.getRawMessages().slice(-2), "reduction:r-test2"); // U2 (通知付き) を整理で落とす
    expect(h.attachDynamicContext(T1)).toBe(true);
    expect(h.getMessages().at(-1)?.content as string).toContain("TODO-1");
  });

  it("末尾が assistant なら添付を見送り、 次の呼び出しで添付する", () => {
    const state = { value: "TODO-1" };
    const h = withState(state);
    h.addUserMessage("U1");
    h.attachDynamicContext(T0);
    state.value = "TODO-2";
    h.addAssistantMessage("途中の応答");
    expect(h.attachDynamicContext(T1)).toBe(false);
    h.addUserMessage("続けて");
    expect(h.attachDynamicContext(T1)).toBe(true);
    expect(h.getMessages().at(-1)?.content as string).toContain("TODO-2");
  });

  it("画像付き user (ContentPart[]) には text パートとして足す", () => {
    const h = withState({ value: "" });
    h.addUserMessage([{ type: "image_url", image_url: { url: "data:x" } }]);
    h.attachDynamicContext(T0);
    const content = h.getMessages().at(-1)?.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as { type: string; text?: string }[];
    expect(parts.length).toBe(2);
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toContain("# Current datetime");
  });

  it("送信済みの部分を書き換える操作は理由を申告し、 取り出すと空になる", () => {
    const h = new MessageHistory("BASE");
    h.addUserMessage("nudge", { ephemeral: true });
    h.addAssistantMessage("", callA, { thinking: "考え中" });
    h.addToolResult("call_a", "R1");
    h.replaceMessages(h.getRawMessages().slice(1), "reduction:r-1");
    h.updateSystemPrompt("BASE"); // 同じ内容なら書き換えではない
    h.updateSystemPrompt("BASE2");
    h.clear();
    expect(h.takeRewriteReasons()).toEqual(["reduction:r-1", "system-prompt", "clear"]);
    expect(h.takeRewriteReasons()).toEqual([]);
    expect(h.getRevision()).toBe(3); // 取り出しても書き換えの回数は戻らない
  });

  it("末尾への追加と状態通知の添付は書き換え理由にならない", () => {
    const h = withState({ value: "TODO-1" });
    h.addUserMessage("U1");
    h.attachDynamicContext(T0);
    h.addAssistantMessage("", callA);
    h.addToolResult("call_a", "R1");
    h.attachDynamicContext(T1);
    expect(h.takeRewriteReasons()).toEqual([]);
  });
});
