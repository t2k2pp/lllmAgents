import { describe, expect, it } from "vitest";
import {
  CACHE_MISS_TOLERANCE_TOKENS,
  CacheMissCauseCollector,
  type CacheMissCauses,
  diagnoseCacheMiss,
  mergeCacheMissCauses,
} from "../../src/agent/cache-miss.js";

/** キャッシュが外れた原因の特定 (docs/context-reduction-redesign.md §10.2) */

const none: CacheMissCauses = { reductionEventIds: [], rewriteReasons: [], sideCallPurposes: [] };

describe("diagnoseCacheMiss", () => {
  it("前回の入力 − 4,096 以上を再利用できていれば外れではない", () => {
    expect(diagnoseCacheMiss({ previousPromptTokens: 100_000, tokensCached: 99_996, causes: none })).toBeNull();
    expect(
      diagnoseCacheMiss({
        previousPromptTokens: 100_000,
        tokensCached: 100_000 - CACHE_MISS_TOLERANCE_TOKENS,
        causes: none,
      }),
    ).toBeNull();
  });

  it("前回が無い・サーバが再利用数を返さないときは判定しない", () => {
    expect(diagnoseCacheMiss({ previousPromptTokens: undefined, tokensCached: 0, causes: none })).toBeNull();
    expect(diagnoseCacheMiss({ previousPromptTokens: 100_000, tokensCached: undefined, causes: none })).toBeNull();
  });

  it("前回の入力が小さく、 幅より下回りようがないときは外れにしない", () => {
    expect(diagnoseCacheMiss({ previousPromptTokens: 3_000, tokensCached: 0, causes: none })).toBeNull();
  });

  it("整理イベントの直後の外れは想定どおり (expected: true)", () => {
    const d = diagnoseCacheMiss({
      previousPromptTokens: 150_000,
      promptTokens: 60_000,
      tokensCached: 0,
      causes: { reductionEventIds: ["r-1"], rewriteReasons: ["reduction:r-1"], sideCallPurposes: [] },
    });
    expect(d).toEqual({
      previousPromptTokens: 150_000,
      promptTokens: 60_000,
      tokensCached: 0,
      causes: ["reduction:r-1", "prefix_break:reduction:r-1"],
      expected: true,
    });
  });

  it("送信済み部分の書き換え理由を原因に挙げる (同じ理由は 1 つにまとめる)", () => {
    const d = diagnoseCacheMiss({
      previousPromptTokens: 80_000,
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
      previousPromptTokens: 80_000,
      tokensCached: 512,
      causes: { reductionEventIds: [], rewriteReasons: [], sideCallPurposes: ["intent", "subagent", "subagent"] },
    });
    expect(d?.causes).toEqual(["side_call:intent", "side_call:subagent"]);
    expect(d?.expected).toBe(false);
  });

  it("何も起きていないのに外れたら unknown", () => {
    const d = diagnoseCacheMiss({ previousPromptTokens: 80_000, tokensCached: 0, causes: none });
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
