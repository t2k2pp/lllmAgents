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

describe("MessageHistory.getMessages — system の stable/dynamic 分割 (プロンプトキャッシュ)", () => {
  it("composer 未設定なら system は 1 メッセージ (後方互換)", () => {
    const h = new MessageHistory("BASE");
    h.addUserMessage("U1");
    const msgs = h.getMessages();
    expect(msgs.filter((m) => m.role === "system").length).toBe(1);
    expect(msgs[0].content).toBe("BASE");
  });

  it("composer が {stable,dynamic} を返すと system が 2 メッセージに分かれる (stable が先頭=キャッシュ対象)", () => {
    const h = new MessageHistory("BASE");
    h.setSystemPromptComposer((base) => ({ stable: base, dynamic: "DT/GOAL/TODO" }));
    h.addUserMessage("U1");
    const msgs = h.getMessages();
    const sys = msgs.filter((m) => m.role === "system");
    expect(sys.length).toBe(2);
    expect(sys[0].content).toBe("BASE"); // 安定 base = キャッシュ対象 (先頭)
    expect(sys[1].content).toBe("DT/GOAL/TODO"); // 動的 = キャッシュ境界より後ろ
  });

  it("dynamic が空文字なら system は 1 メッセージのまま", () => {
    const h = new MessageHistory("BASE");
    h.setSystemPromptComposer((base) => ({ stable: base, dynamic: "   " }));
    const sys = h.getMessages().filter((m) => m.role === "system");
    expect(sys.length).toBe(1);
  });

  it("文字列を返す旧シグネチャ composer は全量 stable 扱い (1 メッセージ)", () => {
    const h = new MessageHistory("BASE");
    h.setSystemPromptComposer((base) => `${base}\n\nEXTRA`);
    const sys = h.getMessages().filter((m) => m.role === "system");
    expect(sys.length).toBe(1);
    expect(sys[0].content).toBe("BASE\n\nEXTRA");
  });
});
