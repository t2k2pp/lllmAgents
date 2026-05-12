import { describe, it, expect } from "vitest";
import { normalizeToolCalls } from "../../src/agent/tool-call-normalizer.js";

describe("normalizeToolCalls — Mistral 形式", () => {
  it("単一の tool call を抽出", () => {
    const text = `[TOOL_CALLS] [{"name": "file_read", "arguments": {"file_path": "/abs/foo.py"}}]`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("mistral");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function.name).toBe("file_read");
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ file_path: "/abs/foo.py" });
  });

  it("arguments が文字列でも (= 既に JSON 文字列化済) 受け付ける", () => {
    const text = `[TOOL_CALLS] [{"name": "bash", "arguments": "{\\"command\\": \\"ls\\"}"}]`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("mistral");
    expect(r.toolCalls[0].function.name).toBe("bash");
  });

  it("テキスト中に thinking 文がある場合も抽出して残す", () => {
    const text = `Let me check the file.\n[TOOL_CALLS] [{"name": "file_read", "arguments": {"file_path": "/x"}}]\nDone.`;
    const r = normalizeToolCalls(text);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.cleanedText).toContain("Let me check");
    expect(r.cleanedText).toContain("Done.");
    expect(r.cleanedText).not.toContain("[TOOL_CALLS]");
  });

  it("壊れた JSON は抽出失敗 (= format=none)", () => {
    const text = `[TOOL_CALLS] [{"name": "foo", "arguments":}]`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("none");
    expect(r.toolCalls).toHaveLength(0);
  });
});

describe("normalizeToolCalls — ChatML 形式", () => {
  it("単一の tool_call タグ", () => {
    const text = `<tool_call>{"name": "grep", "arguments": {"pattern": "TODO", "path": "/abs"}}</tool_call>`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("chatml");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function.name).toBe("grep");
  });

  it("複数 tool_call が連続", () => {
    const text = `<tool_call>{"name": "file_read", "arguments": {"file_path": "/a"}}</tool_call>
<tool_call>{"name": "file_read", "arguments": {"file_path": "/b"}}</tool_call>`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("chatml");
    expect(r.toolCalls).toHaveLength(2);
  });

  it("複数行 JSON を含む tool_call", () => {
    const text = `<tool_call>
{
  "name": "file_write",
  "arguments": {
    "file_path": "/abs/main.py",
    "content": "print(1)"
  }
}
</tool_call>`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("chatml");
    expect(r.toolCalls[0].function.name).toBe("file_write");
  });
});

describe("normalizeToolCalls — Anthropic XML 形式", () => {
  it("単一 tool_call + 単一 parameter (JSON value)", () => {
    const text = `<tool_call><function=refine_with_feedback><parameter=analysis>{"done":false,"summary":"ok"}</parameter></function></tool_call>`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("anthropic-xml");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function.name).toBe("refine_with_feedback");
    const args = JSON.parse(r.toolCalls[0].function.arguments);
    expect(args.analysis).toEqual({ done: false, summary: "ok" });
  });

  it("複数行 + 複数 parameter (混在型)", () => {
    const text = `<tool_call>
<function=create_canvas>
<parameter=canvasPath>/abs/path.json</parameter>
<parameter=size>32</parameter>
<parameter=background>transparent</parameter>
</function>
</tool_call>`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("anthropic-xml");
    const args = JSON.parse(r.toolCalls[0].function.arguments);
    expect(args.canvasPath).toBe("/abs/path.json");
    expect(args.size).toBe(32);
    expect(args.background).toBe("transparent");
  });

  it("実観測ケース (gpt-5.4 reasoning が thinking に書いた形式)", () => {
    // 2026-05-12T14-29-47 session T34 thinking から再構成
    const text = `反復改善ループを続行します。

<tool_call>
<function=mcp__drawdot__refine_with_feedback>
<parameter=analysis>
{
  "done": false,
  "suggestedEdits": [
    {"op": "rect.fill", "x": 4, "y": 3, "w": 8, "h": 1, "color": "#7A5A3A"}
  ]
}
</parameter>
</function>
</tool_call>`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("anthropic-xml");
    expect(r.toolCalls[0].function.name).toBe("mcp__drawdot__refine_with_feedback");
    const args = JSON.parse(r.toolCalls[0].function.arguments);
    expect(args.analysis.suggestedEdits).toHaveLength(1);
  });

  it("clean text にはツール部分が含まれない", () => {
    const text = `説明テキスト<tool_call><function=foo><parameter=k>v</parameter></function></tool_call>後の説明`;
    const r = normalizeToolCalls(text);
    expect(r.cleanedText).toBe("説明テキスト後の説明");
  });
});

describe("normalizeToolCalls — ReAct 形式", () => {
  it("Action + Action Input (JSON)", () => {
    const text = `Thought: I need to read the file.\nAction: file_read\nAction Input: {"file_path": "/abs/main.py"}`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("react");
    expect(r.toolCalls[0].function.name).toBe("file_read");
    expect(JSON.parse(r.toolCalls[0].function.arguments).file_path).toBe("/abs/main.py");
  });

  it("Action Input が non-JSON (生文字列) の場合は input でラップ", () => {
    const text = `Action: bash\nAction Input: ls -la`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("react");
    expect(r.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(r.toolCalls[0].function.arguments).input).toBe("ls -la");
  });
});

describe("normalizeToolCalls — Plain JSON 形式", () => {
  it("テキスト中の裸 JSON (name + arguments)", () => {
    const text = `Sure, here's what I'll do: {"name": "file_read", "arguments": {"file_path": "/a"}} — that should work.`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("plain-json");
    expect(r.toolCalls[0].function.name).toBe("file_read");
  });

  it("name フィールドがない JSON は無視 (誤検知抑制)", () => {
    const text = `Result: {"status": "ok", "count": 42}`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("none"); // = 通常の JSON 出力と区別
  });

  it("parameters / tool / function キーも代替として認識", () => {
    const text1 = `{"tool": "bash", "parameters": {"command": "ls"}}`;
    const r1 = normalizeToolCalls(text1);
    expect(r1.format).toBe("plain-json");
    expect(r1.toolCalls[0].function.name).toBe("bash");

    const text2 = `{"function": "grep", "arguments": {"pattern": "x"}}`;
    const r2 = normalizeToolCalls(text2);
    expect(r2.format).toBe("plain-json");
    expect(r2.toolCalls[0].function.name).toBe("grep");
  });

  it("nested object でもバランスの取れた範囲を抽出", () => {
    const text = `{"name": "task", "arguments": {"type": "code-review", "context": {"files": ["a", "b"]}}}`;
    const r = normalizeToolCalls(text);
    expect(r.format).toBe("plain-json");
    const args = JSON.parse(r.toolCalls[0].function.arguments);
    expect(args.context.files).toEqual(["a", "b"]);
  });
});

describe("normalizeToolCalls — 通常テキスト (false positive なし)", () => {
  it("純粋な日本語応答は format=none", () => {
    const text = "了解しました。 main.py を作成してください。";
    expect(normalizeToolCalls(text).format).toBe("none");
  });

  it("英語の説明文も format=none", () => {
    const text = "I'll read the file and check its contents.";
    expect(normalizeToolCalls(text).format).toBe("none");
  });

  it("空文字列", () => {
    expect(normalizeToolCalls("").format).toBe("none");
  });
});

describe("normalizeToolCalls — ToolCall id 生成", () => {
  it("call_<ts><rnd> 形式", () => {
    const text = `<tool_call>{"name": "x", "arguments": {}}</tool_call>`;
    const r = normalizeToolCalls(text);
    expect(r.toolCalls[0].id).toMatch(/^call_[a-z0-9]+$/);
  });

  it("複数抽出時は id がユニーク", () => {
    const text = `<tool_call>{"name": "a", "arguments": {}}</tool_call>
<tool_call>{"name": "b", "arguments": {}}</tool_call>`;
    const r = normalizeToolCalls(text);
    expect(r.toolCalls[0].id).not.toBe(r.toolCalls[1].id);
  });
});
