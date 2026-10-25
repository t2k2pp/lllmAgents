import { describe, it, expect } from "vitest";
import { MessageHistory } from "../../src/agent/message-history.js";

describe("MessageHistory.replaceOlderMessages — tool_call/tool_result の分断防止", () => {
  it("境界が tool 結果の途中なら、対応する assistant.tool_calls まで遡って recent に含める", () => {
    const history = new MessageHistory("system");
    // 0: user
    history.addUserMessage("話1");
    // 1: assistant (tool_calls)  ← これと 2 のペアが分断されると 400
    history.addAssistantMessage("呼ぶ", [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }]);
    // 2: tool result
    history.addToolResult("call_1", "結果1");
    // 3..12: 追加の会話 (recent=10 とした時に 1 と 2 が境界をまたぐ構造)
    for (let i = 0; i < 10; i++) {
      history.addUserMessage(`q${i}`);
    }

    history.replaceOlderMessages("[要約]", 10);

    const raw = history.getRawMessages();
    // 先頭は要約 (system)
    expect(raw[0].role).toBe("system");
    // 残りメッセージ群に tool 結果が含まれる場合は、対応する assistant.tool_calls もペアで残っている
    const toolMsg = raw.find((m) => m.role === "tool");
    if (toolMsg) {
      const idx = raw.indexOf(toolMsg);
      const before = raw.slice(0, idx);
      const hasMatchingCall = before.some(
        (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.id === "call_1"),
      );
      expect(hasMatchingCall).toBe(true);
    }
  });

  it("recent の先頭が tool 結果単独でも、対応する assistant.tool_calls を巻き取る", () => {
    const history = new MessageHistory("system");
    history.addUserMessage("u1");
    history.addAssistantMessage("a1", [{ id: "call_x", type: "function", function: { name: "f", arguments: "{}" } }]);
    history.addToolResult("call_x", "r1");
    history.addAssistantMessage("a2");
    // keepRecent=2 だと 境界 = length-2 = 2 → recent[0] が tool 結果になり分断される

    history.replaceOlderMessages("[s]", 2);

    const raw = history.getRawMessages();
    const tool = raw.find((m) => m.role === "tool");
    expect(tool).toBeTruthy();
    if (tool) {
      const idx = raw.indexOf(tool);
      const prev = raw[idx - 1];
      expect(prev?.role).toBe("assistant");
      expect((prev as { tool_calls?: unknown }).tool_calls).toBeTruthy();
    }
  });

  it("メッセージ数が keepRecent 以下なら何もしない", () => {
    const history = new MessageHistory("system");
    history.addUserMessage("a");
    history.addAssistantMessage("b");
    const before = history.getRawMessages().length;
    history.replaceOlderMessages("[s]", 10);
    expect(history.getRawMessages().length).toBe(before);
  });
});

describe("MessageHistory.purgeEphemeral — span 境界での揮発メッセージ破棄", () => {
  it("ephemeral=true のメッセージのみ purge され、 永続メッセージは残る", () => {
    const history = new MessageHistory("system");
    history.addUserMessage("U1 (永続: ユーザー実発話)");
    history.addAssistantMessage("A1 (永続: 最終応答相当)");
    history.addUserMessage("[ハーネス] nudge", { ephemeral: true });
    history.addAssistantMessage("（空のレスポンス）", undefined, { ephemeral: true });
    history.addUserMessage("U2 (永続)");

    expect(history.getRawMessages().length).toBe(5);
    const purged = history.purgeEphemeral();
    expect(purged).toBe(2);
    const remaining = history.getRawMessages();
    expect(remaining.length).toBe(3);
    expect(remaining.map((m) => m.content)).toEqual([
      "U1 (永続: ユーザー実発話)",
      "A1 (永続: 最終応答相当)",
      "U2 (永続)",
    ]);
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

      const purged = history.purgeEphemeral();
      expect(purged).toBe(0);
      expect(history.getRawMessages().length).toBe(2);
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = origWarn;
    }
  });

  it("displayed=true の ephemeral は promoteDisplayedEphemeral で永続化され purge を生き残る", () => {
    // 2026-06-12 の実害: 会話リクエストの実回答 (表示済みテキスト) が self-check 経路で
    // ephemeral になり、 span 終了の purge で消えてモデルが自分の回答を参照できなくなった
    const history = new MessageHistory("system");
    history.addUserMessage("感動する四字熟語ベスト10を教えて");
    history.addAssistantMessage("1. 一期一会 …", undefined, { ephemeral: true, displayed: true });
    history.addUserMessage("[ハーネス] self-check nudge", { ephemeral: true });
    history.addAssistantMessage("確認しました (self-check 応答)");

    const promoted = history.promoteDisplayedEphemeral();
    expect(promoted).toBe(1);
    const purged = history.purgeEphemeral();
    expect(purged).toBe(1); // nudge のみ purge
    expect(history.getRawMessages().map((m) => m.content)).toEqual([
      "感動する四字熟語ベスト10を教えて",
      "1. 一期一会 …",
      "確認しました (self-check 応答)",
    ]);
  });

  it("displayed=false (未表示 placeholder 等) は promote されず purge される", () => {
    const history = new MessageHistory("system");
    history.addAssistantMessage("（空のレスポンス）", undefined, { ephemeral: true });
    history.addAssistantMessage("表示済み", undefined, { ephemeral: true, displayed: true });
    expect(history.promoteDisplayedEphemeral()).toBe(1);
    expect(history.purgeEphemeral()).toBe(1);
    expect(history.getRawMessages().map((m) => m.content)).toEqual(["表示済み"]);
  });

  it("複数回 purge 呼んでも 2 回目以降は 0 件 (idempotent)", () => {
    const history = new MessageHistory("system");
    history.addUserMessage("nudge", { ephemeral: true });
    expect(history.purgeEphemeral()).toBe(1);
    expect(history.purgeEphemeral()).toBe(0);
  });

  it("purge 後に追加した ephemeral も次の purge で除去される (span をまたいで状態が混じらない)", () => {
    const history = new MessageHistory("system");
    history.addUserMessage("nudge1", { ephemeral: true });
    history.purgeEphemeral();
    history.addUserMessage("U-permanent");
    history.addUserMessage("nudge2", { ephemeral: true });
    const purged = history.purgeEphemeral();
    expect(purged).toBe(1);
    expect(history.getRawMessages().map((m) => m.content)).toEqual(["U-permanent"]);
  });

  it("ephemeral メッセージは provider 用の getMessages() でも他と区別なく見える (in-turn 中は届く)", () => {
    const history = new MessageHistory("sys");
    history.addUserMessage("U1");
    history.addUserMessage("[ハーネス] nudge", { ephemeral: true });
    const all = history.getMessages();
    // [system, U1, nudge]
    expect(all.length).toBe(3);
    expect(all[0].role).toBe("system");
    expect(all[2].content).toBe("[ハーネス] nudge");
    // ephemeral フィールドはメッセージオブジェクトに載らない (provider にリークしない)
    expect((all[2] as Record<string, unknown>).ephemeral).toBeUndefined();
  });

  it("isEphemeral() で個別判定可能", () => {
    const history = new MessageHistory("sys");
    history.addUserMessage("permanent");
    history.addUserMessage("temp", { ephemeral: true });
    const raw = history.getRawMessages();
    expect(history.isEphemeral(raw[0])).toBe(false);
    expect(history.isEphemeral(raw[1])).toBe(true);
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

  it("前回通知を付けたメッセージが消えたら (揮発除去など) 状態を出し直す", () => {
    const h = withState({ value: "TODO-1" });
    h.addUserMessage("nudge", { ephemeral: true });
    h.attachDynamicContext(T0);
    h.purgeEphemeral();
    h.addUserMessage("U2");
    h.attachDynamicContext(T1);
    h.addAssistantMessage("", callA);
    h.addToolResult("call_a", "R1");
    h.replaceOlderMessages("要約", 2); // U2 (通知付き) を圧縮で落とす
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
    h.purgeEphemeral();
    h.clearAllThinking();
    h.updateSystemPrompt("BASE"); // 同じ内容なら書き換えではない
    h.updateSystemPrompt("BASE2");
    expect(h.takeRewriteReasons()).toEqual(["ephemeral-purge", "thinking-clear", "system-prompt"]);
    expect(h.takeRewriteReasons()).toEqual([]);
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
