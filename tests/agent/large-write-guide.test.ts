import { beforeEach, describe, expect, it } from "vitest";
import { largeNewFileGuide } from "../../src/agent/agent-loop.js";
import { LARGE_NEW_FILE_CHARS, resetPerRequestGuides, resetToolGuides } from "../../src/agent/tool-guides.js";
import type { ToolCall } from "../../src/providers/base-provider.js";

// 新規ファイルを一度に大きく書いたら、 1 つずつ確かめて進める手引きを依頼ごとに 1 回だけ添える。
// 作業は止めない (時間・長さでの打ち切りはしない)。 docs/todo-request-elaboration.md 第 3 段 項目 17

function writeCall(content: string): ToolCall {
  return {
    id: "w",
    type: "function",
    function: { name: "file_write", arguments: JSON.stringify({ file_path: "/x/index.html", content }) },
  };
}
const big = "x".repeat(LARGE_NEW_FILE_CHARS + 1);
const created = { success: true, output: "[file_write] created: /x/index.html | 25282 bytes" };

describe("大きな新規ファイルを書いた後の手引き", () => {
  beforeEach(() => resetToolGuides());

  it("大きな新規ファイルなら 1 度だけ添える", () => {
    expect(largeNewFileGuide(writeCall(big), created)).toContain("ToDo の機能を 1 つずつ");
    expect(largeNewFileGuide(writeCall(big), created)).toBeNull();
  });

  it("新しい依頼では再び添える", () => {
    largeNewFileGuide(writeCall(big), created);
    resetPerRequestGuides();
    expect(largeNewFileGuide(writeCall(big), created)).not.toBeNull();
  });

  it("小さいファイル・上書き・失敗・他ツールには添えない", () => {
    expect(largeNewFileGuide(writeCall("small"), created)).toBeNull();
    expect(largeNewFileGuide(writeCall(big), { success: true, output: "[file_write] overwritten: /x" })).toBeNull();
    expect(largeNewFileGuide(writeCall(big), { success: false, output: "" })).toBeNull();
    const bash: ToolCall = { id: "b", type: "function", function: { name: "bash", arguments: "{}" } };
    expect(largeNewFileGuide(bash, created)).toBeNull();
  });
});
