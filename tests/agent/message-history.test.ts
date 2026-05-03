import { describe, it, expect } from "vitest";
import { MessageHistory } from "../../src/agent/message-history.js";

describe("MessageHistory.replaceOlderMessages — tool_call/tool_result の分断防止", () => {
  it("境界が tool 結果の途中なら、対応する assistant.tool_calls まで遡って recent に含める", () => {
    const history = new MessageHistory("system");
    // 0: user
    history.addUserMessage("話1");
    // 1: assistant (tool_calls)  ← これと 2 のペアが分断されると 400
    history.addAssistantMessage("呼ぶ", [
      { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
    ]);
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
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.tool_calls) &&
          m.tool_calls.some((c) => c.id === "call_1"),
      );
      expect(hasMatchingCall).toBe(true);
    }
  });

  it("recent の先頭が tool 結果単独でも、対応する assistant.tool_calls を巻き取る", () => {
    const history = new MessageHistory("system");
    history.addUserMessage("u1");
    history.addAssistantMessage("a1", [
      { id: "call_x", type: "function", function: { name: "f", arguments: "{}" } },
    ]);
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
