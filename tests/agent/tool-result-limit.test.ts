import { describe, expect, it } from "vitest";
import { TIER_CONTEXT_BUDGETS } from "../../src/agent/capability-tier.js";
import { estimateTokens } from "../../src/agent/token-counter.js";
import {
  MIN_TOOL_RESULT_TOKENS,
  ToolResultBatch,
  truncateToolResultToTokens,
} from "../../src/agent/tool-result-limit.js";

/** 頭と尻尾が判別できる ASCII の本文 (1 文字 0.25 トークン) */
function asciiBody(chars: number): string {
  const head = "HEAD-START ";
  const tail = " TAIL-END";
  return head + "a".repeat(chars - head.length - tail.length) + tail;
}

/** 全角の本文 (1 文字 1 トークン) */
function wideBody(chars: number): string {
  return `始${"あ".repeat(chars - 2)}終`;
}

describe("1 件の切り詰め (トークン数基準。 docs/context-reduction-redesign.md §4.3)", () => {
  it("上限以下ならそのまま返す", () => {
    const text = asciiBody(1_000);
    expect(truncateToolResultToTokens("bash", text, 2_048, { reason: "per-result", totalTokens: 8_192 })).toBe(text);
  });

  it.each([
    ["ASCII", asciiBody(100_000), "HEAD-START", "TAIL-END"],
    ["全角", wideBody(20_000), "始", "終"],
  ])("%s: 注記を含めて上限以下に収め、 頭と尻尾を残す", (_label, text, head, tail) => {
    for (const limit of [8_192, 5_120, 2_048, MIN_TOOL_RESULT_TOKENS]) {
      const out = truncateToolResultToTokens("bash", text, limit, { reason: "per-result", totalTokens: 24_576 });
      expect(estimateTokens(out)).toBeLessThanOrEqual(limit);
      // 上限いっぱい近くまで使う (無駄に短くしない)
      expect(estimateTokens(out)).toBeGreaterThan(limit - 8);
      expect(out.startsWith(head)).toBe(true);
      expect(out.endsWith(tail)).toBe(true);
      expect(out).toContain("[truncated by the harness:");
      expect(out).toContain(`the limit for one tool result is ${limit} tokens`);
    }
  });

  it("全角の多い結果は同じ上限でも文字数では短く切られる (2026-10-25 許容済み)", () => {
    const ascii = truncateToolResultToTokens("bash", asciiBody(100_000), 2_048, {
      reason: "per-result",
      totalTokens: 8_192,
    });
    const wide = truncateToolResultToTokens("bash", wideBody(100_000), 2_048, {
      reason: "per-result",
      totalTokens: 8_192,
    });
    expect(Array.from(wide).length).toBeLessThan(Array.from(ascii).length / 2);
  });

  it("注記に元の大きさと切った文字数が出る", () => {
    const text = asciiBody(40_000);
    const out = truncateToolResultToTokens("file_read", text, 1_024, { reason: "per-result", totalTokens: 8_192 });
    const kept = Array.from(out).length;
    expect(out).toMatch(/(\d+) of 40000 characters were removed/);
    const removed = Number(out.match(/(\d+) of 40000 characters were removed/)?.[1]);
    // 残した本文 + 注記 = 出力。 切った量 + 残した本文 = 元の長さ
    const note = out.slice(out.indexOf("\n\n...[truncated"), out.indexOf("]...\n\n") + "]...\n\n".length);
    expect(removed + (kept - Array.from(note).length)).toBe(40_000);
    expect(out).toContain(`"file_read" result (about ${estimateTokens(text)} tokens in full)`);
  });
});

describe("同じ応答の合計の上限 T", () => {
  const limits = { perResultTokens: 2_048, totalTokens: 8_192 };

  it("後の結果ほど強く切る (残りの枠まで。 最低量は残す)", () => {
    const batch = new ToolResultBatch(limits);
    const big = asciiBody(40_000); // 約 11,000 トークン
    const fits = Array.from({ length: 6 }, () => batch.fit("bash", big));
    const sizes = fits.map((f) => estimateTokens(f.content));
    // 1〜4 件目は 1 件の上限まで、 5 件目以降は合計を使い切ったので最低量
    for (let i = 0; i < 4; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(2_048);
      expect(fits[i].truncation?.reason).toBe("per-result");
    }
    for (const i of [4, 5]) {
      expect(sizes[i]).toBeLessThanOrEqual(MIN_TOOL_RESULT_TOKENS);
      expect(fits[i].truncation?.reason).toBe("response-total");
      expect(fits[i].content).toContain("reached their combined limit of 8192 tokens");
    }
    expect(fits.every((f, i) => f.tokens === sizes[i])).toBe(true);
    expect(batch.usedTokens).toBe(sizes.reduce((a, b) => a + b, 0));
  });

  it("残りの枠が 1 件の上限より小さいときは残りの枠まで切る", () => {
    const batch = new ToolResultBatch(limits);
    const first = batch.fit("bash", "x".repeat(25_000)); // 6,875 トークン → 2,048 に切る
    expect(first.tokens).toBeLessThanOrEqual(2_048);
    batch.fit("bash", "y".repeat(20_000)); // もう 1 件 2,048
    batch.fit("bash", "z".repeat(10_000)); // 2,750 → 2,048
    batch.fit("bash", "v".repeat(2_000)); // 550 (切らない)
    const remaining = 8_192 - batch.usedTokens;
    expect(remaining).toBeGreaterThan(MIN_TOOL_RESULT_TOKENS);
    expect(remaining).toBeLessThan(2_048);
    const last = batch.fit("bash", "w".repeat(20_000));
    expect(last.truncation).toMatchObject({ reason: "response-total", allowedTokens: remaining });
    expect(last.tokens).toBeLessThanOrEqual(remaining);
    expect(batch.usedTokens).toBeLessThanOrEqual(8_192);
  });

  it("小さい結果は合計に数えるが切らない", () => {
    const batch = new ToolResultBatch(limits);
    const small = batch.fit("bash", "ok");
    expect(small).toEqual({ content: "ok", tokens: estimateTokens("ok"), truncation: null });
    expect(batch.usedTokens).toBe(estimateTokens("ok"));
  });

  it("file_write / file_edit は切らないが合計には数え、 後の結果がその分短くなる", () => {
    const batch = new ToolResultBatch(limits);
    const longWrite = asciiBody(30_000); // 約 8,250 トークン (1 件の上限も合計も超える)
    const w = batch.fit("file_write", longWrite);
    expect(w.content).toBe(longWrite);
    expect(w.truncation).toBeNull();
    const e = batch.fit("file_edit", longWrite);
    expect(e.content).toBe(longWrite);
    expect(batch.usedTokens).toBe(2 * estimateTokens(longWrite));
    // 合計を使い切っているので、 次の読み取りは最低量まで切られる
    const read = batch.fit("file_read", asciiBody(40_000));
    expect(read.truncation?.reason).toBe("response-total");
    expect(read.tokens).toBeLessThanOrEqual(MIN_TOOL_RESULT_TOKENS);
  });

  it("同じ順に入れれば同じ結果になる (並列で終わる順によらず、 入れる順で決まる)", () => {
    const inputs = [asciiBody(30_000), "short", wideBody(5_000), asciiBody(9_000), asciiBody(50_000)];
    const run = () => {
      const batch = new ToolResultBatch(limits);
      return inputs.map((t) => batch.fit("bash", t).content);
    };
    expect(run()).toEqual(run());
  });

  it("ティアの値: T1 8,192 / T2 5,120 / T3 2,048 トークン、 合計 T は 1 件の上限以上", () => {
    for (const tier of ["T1", "T2", "T3"] as const) {
      const b = TIER_CONTEXT_BUDGETS[tier];
      expect(b.toolResultTotalTokens).toBeGreaterThanOrEqual(b.toolResultLimitTokens);
      expect(b.toolResultLimitTokens).toBeGreaterThan(MIN_TOOL_RESULT_TOKENS);
    }
  });
});
