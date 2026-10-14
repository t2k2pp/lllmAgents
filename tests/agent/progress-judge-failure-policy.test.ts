import { describe, expect, it } from "vitest";
import type { ChatChunk, LLMProvider } from "../../src/providers/base-provider.js";
import { judgeProgress, parseJudgeResponse } from "../../src/agent/progress-judge.js";

function providerThat(result: string | Error): LLMProvider {
  const chat = async function* (): AsyncGenerator<ChatChunk> {
    if (result instanceof Error) throw result;
    yield { type: "text", text: result } as ChatChunk;
    yield { type: "done", finishReason: "stop" } as ChatChunk;
  };
  return { chat } as unknown as LLMProvider;
}

const baseInput = {
  originalUserMessage: "実装して",
  recentSummary: "file_edit を実行",
  latestResponse: { text: "完了しました", toolCalls: [] },
  model: "judge-model",
};

describe("progress judge failure policy", () => {
  it("有効な verdict JSON だけを受理する", () => {
    expect(parseJudgeResponse('{"verdict":"answered","reason":"実装済み"}')).toEqual({
      verdict: "answered",
      reason: "実装済み",
    });
  });

  it("不正応答を took_step に自動置換しない", () => {
    expect(() => parseJudgeResponse("判定できません")).toThrow("有効な verdict JSON");
    expect(() => parseJudgeResponse('{"verdict":"unknown"}')).toThrow("有効な verdict JSON");
  });

  it("provider 失敗を成功寄り判定に自動置換しない", async () => {
    await expect(
      judgeProgress({ ...baseInput, provider: providerThat(new Error("connection refused")) }),
    ).rejects.toThrow("progress judge の判定に失敗しました");
  });

  it("provider の非 JSON 応答も呼び出し元へ失敗として返す", async () => {
    await expect(judgeProgress({ ...baseInput, provider: providerThat("not json") })).rejects.toThrow(
      "有効な verdict JSON",
    );
  });
});

/** 思考モデルが 200 tok を思考で使い切る件 (docs/context-reduction-reasoning-model-fix.md §5) */
describe("progress judge: 思考オフと失敗理由", () => {
  it("disableThinking=true で呼ぶ", async () => {
    const calls: Array<{ disableThinking?: boolean }> = [];
    const provider = {
      async *chat(params: { disableThinking?: boolean }): AsyncGenerator<ChatChunk> {
        calls.push(params);
        yield { type: "text", text: '{"verdict":"took_step","reason":"r"}' } as ChatChunk;
        yield { type: "done", finishReason: "stop" } as ChatChunk;
      },
    } as unknown as LLMProvider;
    await judgeProgress({ ...baseInput, provider });
    expect(calls[0].disableThinking).toBe(true);
  });

  it("本文が空なら finishReason を含めて失敗させる", async () => {
    const provider = {
      async *chat(): AsyncGenerator<ChatChunk> {
        yield { type: "thinking", text: "..." } as ChatChunk;
        yield { type: "done", finishReason: "length" } as ChatChunk;
      },
    } as unknown as LLMProvider;
    await expect(judgeProgress({ ...baseInput, provider })).rejects.toThrow("finishReason=length");
  });
});
