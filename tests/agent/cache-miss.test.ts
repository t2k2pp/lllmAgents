import { describe, expect, it } from "vitest";
import {
  CACHE_MISS_TOLERANCE_TOKENS,
  CacheMissCauseCollector,
  type CacheMissCauses,
  diagnoseCacheMiss,
  mergeCacheMissCauses,
  type PromptSend,
} from "../../src/agent/cache-miss.js";
import type { PromptFingerprint } from "../../src/agent/prompt-fingerprint.js";

/** キャッシュが外れた原因の特定 (docs/context-reduction-redesign.md §10.2) */

const none: CacheMissCauses = { reductionEventIds: [], rewriteReasons: [], sideCallPurposes: [] };

const main = (promptTokens: number): PromptSend => ({ kind: "main", promptTokens });

function fp(messages: string[], tools = "t1", settings = "s1"): PromptFingerprint {
  return { settings, tools, messages };
}

describe("diagnoseCacheMiss", () => {
  it("前回の入力 − 4,096 以上を再利用できていれば外れではない", () => {
    expect(diagnoseCacheMiss({ previous: main(100_000), tokensCached: 99_996, causes: none })).toBeNull();
    expect(
      diagnoseCacheMiss({
        previous: main(100_000),
        tokensCached: 100_000 - CACHE_MISS_TOLERANCE_TOKENS,
        causes: none,
      }),
    ).toBeNull();
  });

  it("前回が無い・サーバが再利用数を返さないときは判定しない", () => {
    expect(diagnoseCacheMiss({ previous: undefined, tokensCached: 0, causes: none })).toBeNull();
    expect(diagnoseCacheMiss({ previous: main(100_000), tokensCached: undefined, causes: none })).toBeNull();
  });

  it("前回の入力が小さく、 幅より下回りようがないときは外れにしない", () => {
    expect(diagnoseCacheMiss({ previous: main(3_000), tokensCached: 0, causes: none })).toBeNull();
  });

  it("整理イベントの直後の外れは想定どおり (expected: true)", () => {
    const d = diagnoseCacheMiss({
      previous: main(150_000),
      promptTokens: 60_000,
      tokensCached: 0,
      causes: { reductionEventIds: ["r-1"], rewriteReasons: ["reduction:r-1"], sideCallPurposes: [] },
    });
    expect(d).toEqual({
      against: "main",
      previousPromptTokens: 150_000,
      promptTokens: 60_000,
      tokensCached: 0,
      causes: ["reduction:r-1", "prefix_break:reduction:r-1"],
      expected: true,
    });
  });

  it("送信済み部分の書き換え理由を原因に挙げる (同じ理由は 1 つにまとめる)", () => {
    const d = diagnoseCacheMiss({
      previous: main(80_000),
      tokensCached: 2_000,
      causes: {
        reductionEventIds: [],
        rewriteReasons: ["ephemeral-purge", "thinking-clear", "ephemeral-purge"],
        sideCallPurposes: [],
      },
    });
    expect(d?.causes).toEqual(["prefix_break:ephemeral-purge", "prefix_break:thinking-clear"]);
    expect(d?.expected).toBe(false);
  });

  it("間にあった脇の呼び出しの目的を原因に挙げる", () => {
    const d = diagnoseCacheMiss({
      previous: main(80_000),
      tokensCached: 512,
      causes: { reductionEventIds: [], rewriteReasons: [], sideCallPurposes: ["intent", "subagent", "subagent"] },
    });
    expect(d?.causes).toEqual(["side_call:intent", "side_call:subagent"]);
    expect(d?.expected).toBe(false);
  });

  it("前回の本体呼び出しが無くても、 送り終えた先読みがあればそれと比べる (先読みが効いたか)", () => {
    const prewarm: PromptSend = { kind: "prewarm", promptTokens: 37_488 };
    // 2026-10-26 実機: 先読み 37,488 の後の本体呼び出しの再利用が 9,157 だけ
    expect(
      diagnoseCacheMiss({ previous: prewarm, promptTokens: 37_945, tokensCached: 9_157, causes: none }),
    ).toMatchObject({ against: "prewarm", previousPromptTokens: 37_488, tokensCached: 9_157, expected: false });
    // 先読みが効いた (先読みの入力 − 4)
    expect(
      diagnoseCacheMiss({ previous: prewarm, promptTokens: 37_945, tokensCached: 37_484, causes: none }),
    ).toBeNull();
    // 先読みが入力を返さなかったら判定しない
    expect(diagnoseCacheMiss({ previous: { kind: "prewarm" }, tokensCached: 0, causes: none })).toBeNull();
  });

  it("両方の指紋があれば、 比べた相手と何件目からずれたかを載せる", () => {
    const previous: PromptSend = { kind: "prewarm", promptTokens: 30_000, fingerprint: fp(["sys", "u1", "a1"]) };
    const sameSequence = diagnoseCacheMiss({
      previous,
      tokensCached: 0,
      fingerprint: fp(["sys", "u1", "a1", "u2"]),
      causes: none,
    });
    expect(sameSequence?.divergence).toEqual({
      against: "prewarm",
      settingsChanged: false,
      toolsChanged: false,
      firstDifferentMessage: null,
      previousMessageCount: 3,
      messageCount: 4,
    });
    const toolsAdded = diagnoseCacheMiss({
      previous,
      tokensCached: 0,
      fingerprint: fp(["sys", "u1", "a1", "u2"], "t2"),
      causes: none,
    });
    expect(toolsAdded?.divergence).toMatchObject({
      toolsChanged: true,
      settingsChanged: false,
      firstDifferentMessage: null,
    });
    const rewritten = diagnoseCacheMiss({
      previous,
      tokensCached: 0,
      fingerprint: fp(["sys", "u1-changed", "a1", "u2"], "t1", "s2"),
      causes: none,
    });
    expect(rewritten?.divergence).toMatchObject({ settingsChanged: true, firstDifferentMessage: 1 });
    // 指紋が片方でも無ければ載せない
    expect(
      diagnoseCacheMiss({ previous: main(30_000), tokensCached: 0, fingerprint: fp([]), causes: none }),
    ).not.toHaveProperty("divergence");
  });

  it("何も起きていないのに外れたら unknown", () => {
    const d = diagnoseCacheMiss({ previous: main(80_000), tokensCached: 0, causes: none });
    expect(d?.causes).toEqual(["unknown"]);
    expect(d?.expected).toBe(false);
  });
});

describe("CacheMissCauseCollector", () => {
  it("取り出すと空になり、 次の区間には持ち越さない", () => {
    const c = new CacheMissCauseCollector();
    c.noteSideCall("intent");
    c.noteReductionEvent("r-7");
    expect(c.take(["clear"])).toEqual({
      reductionEventIds: ["r-7"],
      rewriteReasons: ["clear"],
      sideCallPurposes: ["intent"],
    });
    expect(c.take([])).toEqual(none);
  });

  it("比べる相手が先読みに替わったら、 それより前にためたことを捨てる (同じ履歴の書き換え理由は件数分を読み飛ばす)", () => {
    const c = new CacheMissCauseCollector();
    const history = {};
    c.noteReductionEvent("r-2");
    c.noteSideCall("intent");
    c.restartFrom(history, 1);
    c.noteSideCall("progress");
    expect(c.take(["reduction:r-2", "ephemeral-purge"], history)).toEqual({
      reductionEventIds: [],
      rewriteReasons: ["ephemeral-purge"],
      sideCallPurposes: ["progress"],
    });
    // 読み飛ばしは 1 回きり
    expect(c.take(["replace"], history).rewriteReasons).toEqual(["replace"]);
    // 履歴を載せ替えたら件数は当てはまらないので読み飛ばさない
    c.restartFrom(history, 1);
    expect(c.take(["replace"], {}).rewriteReasons).toEqual(["replace"]);
  });

  it("再試行で送り直した分と合わせられる", () => {
    const merged = mergeCacheMissCauses(
      { reductionEventIds: ["r-1"], rewriteReasons: [], sideCallPurposes: ["handoff"] },
      { reductionEventIds: [], rewriteReasons: ["replace"], sideCallPurposes: ["progress"] },
    );
    expect(merged).toEqual({
      reductionEventIds: ["r-1"],
      rewriteReasons: ["replace"],
      sideCallPurposes: ["handoff", "progress"],
    });
  });
});
