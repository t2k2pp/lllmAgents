import { describe, expect, it, vi } from "vitest";
import { runHandoff, generateHandoffNote } from "../../src/agent/handoff.js";
import { MessageHistory } from "../../src/agent/message-history.js";
import type { ChatChunk, LLMProvider } from "../../src/providers/base-provider.js";

function history() {
  const h = new MessageHistory("system");
  h.addUserMessage("購入元アセットを変更しない。並列実行は禁止。未完了の実装を続ける。");
  return h;
}
function provider(text: string, finishReason = "stop") {
  const chat = vi.fn(async function* (): AsyncGenerator<ChatChunk> {
    yield { type: "text", text };
    yield { type: "done", finishReason };
  });
  return { chat } as unknown as LLMProvider & { chat: typeof chat };
}

describe("explicit file handoff", () => {
  it("LLMを呼ばず全履歴の保存後だけ指定メモへ置換する", async () => {
    const h = history();
    const old = h.getRawMessages();
    const p = provider("");
    const result = await runHandoff(p, "m", h, {
      providedNote: "実装済み。次は見た目を整える。並列禁止、購入元アセットは保護。操作感は未確認。",
      saveSession: () => {
        expect(h.getRawMessages()).toEqual(old);
        return "archive";
      },
    });
    expect(result.applied).toBe(true);
    expect(p.chat).not.toHaveBeenCalled();
    expect(h.getRawMessages()).toHaveLength(1);
    expect(h.getRawMessages()[0].content).toContain("利用者がファイルから指定");
    expect(h.getRawMessages()[0].content).toContain("archive");
  });
  it.each([
    undefined,
    () => undefined,
    () => {
      throw new Error("disk full");
    },
  ])("保存できなければ履歴を保持", async (saveSession) => {
    const h = history();
    const old = h.getRawMessages();
    const p = provider("");
    const r = await runHandoff(p, "m", h, { providedNote: "守るべき制約と次の作業", saveSession });
    expect(r.applied).toBe(false);
    expect(h.getRawMessages()).toEqual(old);
    expect(p.chat).not.toHaveBeenCalled();
  });
  it.each(["   ", "長".repeat(16_001)])("空または過大なメモで履歴を消さない", async (providedNote) => {
    const h = history();
    const saveSession = vi.fn(() => "archive");
    const r = await runHandoff(provider(""), "m", h, { providedNote, saveSession });
    expect(r.applied).toBe(false);
    expect(saveSession).not.toHaveBeenCalled();
  });
});

describe("context failure diagnostics", () => {
  it("引き継ぎ生成の429は1回で停止し履歴を保持", async () => {
    const p = provider("");
    p.chat.mockImplementation(async function* () {
      yield { type: "text", text: "partial" };
      throw new Error("HTTP 429 rate_limit_exceeded");
    });
    const h = history();
    const old = h.getRawMessages();
    await expect(runHandoff(p, "m", h)).rejects.toThrow("429");
    expect(p.chat).toHaveBeenCalledTimes(1);
    expect(h.getRawMessages()).toEqual(old);
  });
  it("打ち切られた引き継ぎは見出しが揃っても採用しない", async () => {
    const p = provider("## これまでにやったこと\n- 実装済みの内容。\n## 次にやること\n- 次の作業の途中", "length");
    const result = await generateHandoffNote(p, "m", history().getRawMessages());
    expect(result.note).toBeNull();
    expect(result.reason).toContain("finishReason=length");
  });
});

/** 引き継ぎメモは思考を残し、 上限を十分に取る (docs/archive/context-reduction-reasoning-model-fix.md §5) */
describe("generateHandoffNote: 思考と出力上限", () => {
  it("思考はオフにせず、 出力上限は思考込みで収まる大きさ (>= 4000) にする", async () => {
    const calls: Array<{ disableThinking?: boolean; maxTokens?: number }> = [];
    const provider = {
      async *chat(params: { disableThinking?: boolean; maxTokens?: number }): AsyncGenerator<ChatChunk> {
        calls.push(params);
        yield {
          type: "text",
          text: "## これまでにやったこと\n- a\n\n## 次にやること\n- b\n\n## 守るべき制約・決定事項\n- なし",
        };
        yield { type: "done", finishReason: "stop" };
      },
    } as unknown as LLMProvider;
    await generateHandoffNote(provider, "m", [{ role: "user", content: "作業して" }]);
    expect(calls[0].disableThinking).toBeFalsy();
    expect(calls[0].maxTokens ?? 0).toBeGreaterThanOrEqual(4000);
  });
});
