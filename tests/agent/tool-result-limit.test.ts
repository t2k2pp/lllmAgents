import { describe, expect, it } from "vitest";
import { TIER_CONTEXT_BUDGETS } from "../../src/agent/capability-tier.js";
import { estimateTokens, MESSAGE_OVERHEAD_TOKENS } from "../../src/agent/token-counter.js";
import {
  BRIEF_OMISSION_NOTES,
  fullOmissionNote,
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

/** 入れた結果の合計 (本文 + 1 件の枠)。 ToolResultBatch.usedTokens と同じ数え方 */
function costOf(fits: readonly { tokens: number }[]): number {
  return fits.reduce((sum, f) => sum + f.tokens + MESSAGE_OVERHEAD_TOKENS, 0);
}

describe("同じ応答の合計の上限 T (2026-10-26 改訂: 注記を含めて必ず T 以下)", () => {
  const limits = { perResultTokens: 2_048, totalTokens: 8_192 };
  const names = (n: number, name = "bash") => Array.from({ length: n }, () => name);

  it("1 件の上限で切り、 合計の残りで切り、 残りが最低量に届かなくなったら本文を省いて注記だけにする", () => {
    const batch = new ToolResultBatch(limits, names(6));
    const big = asciiBody(40_000); // 約 11,000 トークン
    const fits = Array.from({ length: 6 }, () => batch.fit("bash", big));
    // 1〜3 件目は 1 件の上限まで
    for (let i = 0; i < 3; i++) {
      expect(fits[i].tokens).toBeLessThanOrEqual(2_048);
      expect(fits[i].truncation?.reason).toBe("per-result");
    }
    // 4 件目は合計の残り (残りの 2 件の注記の分を引いた量) まで
    expect(fits[3].truncation?.reason).toBe("response-total");
    expect(fits[3].content).toContain("reached their combined limit of 8192 tokens");
    expect(fits[3].tokens).toBeGreaterThanOrEqual(MIN_TOOL_RESULT_TOKENS);
    // 5・6 件目は本文を省く。 最初に省いた結果は長い注記
    expect(fits[4].truncation?.reason).toBe("omitted");
    expect(fits[4].content).toBe(fullOmissionNote("bash", false, 8_192, BRIEF_OMISSION_NOTES[0]));
    expect(fits[4].content).not.toContain("HEAD-START");
    expect(fits[5].truncation?.reason).toBe("omitted");
    // 合計は注記を含めて T 以下 (切ったときも)
    expect(batch.usedTokens).toBe(costOf(fits));
    expect(batch.usedTokens).toBeLessThanOrEqual(8_192);
    expect(batch.summary()).toMatchObject({
      callCount: 6,
      truncatedByTotal: 1,
      omitted: ["bash", "bash"],
      overflow: false,
    });
  });

  it("後の呼び出しの注記の分を先に残す: 呼び出しが多いと、 前の結果もその分短く切られる", () => {
    const few = new ToolResultBatch(limits, names(2));
    const many = new ToolResultBatch(limits, names(200));
    const a = few.fit("bash", asciiBody(40_000));
    const b = many.fit("bash", asciiBody(40_000));
    expect(a.tokens).toBeLessThanOrEqual(2_048);
    expect(b.tokens).toBeLessThanOrEqual(2_048);
    // 200 件では残りの 199 件の注記の分を残すので、 2 件目以降はすぐに合計の残りで切られる
    const rest = Array.from({ length: 199 }, () => many.fit("bash", asciiBody(4_000)));
    expect(many.usedTokens).toBe(costOf([b, ...rest]));
    expect(many.usedTokens).toBeLessThanOrEqual(8_192);
    expect(rest.filter((f) => f.truncation?.reason === "omitted").length).toBeGreaterThan(150);
  });

  it("2 件目以降に省いた結果は、 余裕があれば長い注記、 なければ短い注記 (成否だけ)", () => {
    const batch = new ToolResultBatch(limits, names(300, "todo_append"));
    const fits = Array.from({ length: 300 }, (_, i) =>
      batch.fit("todo_append", i % 7 === 3 ? `Error: failed ${"e".repeat(2_000)}` : asciiBody(2_000)),
    );
    const omitted = fits.filter((f) => f.truncation?.reason === "omitted");
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted[0].content).toContain("[Result omitted by the harness:");
    const brief = omitted.filter((f) => !f.content.includes("[Result omitted by the harness:"));
    expect(brief.length).toBeGreaterThan(0);
    for (const f of brief) expect(["[omitted; ok]", "Error: [omitted]"]).toContain(f.content);
    // 失敗の結果は省いても `Error: ` で始まる (成否が消えない)
    fits.forEach((f, i) => {
      if (i % 7 === 3) expect(f.content.startsWith("Error: ")).toBe(true);
      else expect(f.content.startsWith("Error: ")).toBe(false);
    });
    expect(batch.usedTokens).toBe(costOf(fits));
    expect(batch.usedTokens).toBeLessThanOrEqual(8_192);
  });

  it("小さい結果は合計に数えるが切らない (数えるのは本文 + 1 件の枠)", () => {
    const batch = new ToolResultBatch(limits, names(1));
    const small = batch.fit("bash", "ok");
    expect(small).toEqual({ content: "ok", tokens: estimateTokens("ok"), truncation: null });
    expect(batch.usedTokens).toBe(estimateTokens("ok") + MESSAGE_OVERHEAD_TOKENS);
  });

  it("file_write / file_edit は切らない。 入るならそのまま、 入らなければ本文を注記にして成否を残す", () => {
    const batch = new ToolResultBatch(limits, ["file_write", "file_edit", "file_write", "file_edit"]);
    const longWrite = asciiBody(20_000); // 約 5,500 トークン (1 件の上限は超えるが合計の残りには入る)
    const w = batch.fit("file_write", longWrite);
    expect(w.content).toBe(longWrite);
    expect(w.truncation).toBeNull();
    // 合計の残りに入らない成功の結果: 本文を注記にし、 成功したことを書く
    const e = batch.fit("file_edit", longWrite);
    expect(e.truncation?.reason).toBe("omitted");
    expect(e.content).toBe(fullOmissionNote("file_edit", false, 8_192, BRIEF_OMISSION_NOTES[0]));
    expect(e.content).toContain("reported success");
    // 失敗の結果: `Error: ` で始まり、 失敗したことを書く
    const failed = batch.fit("file_write", `Error: permission denied\n${asciiBody(20_000)}`);
    expect(failed.truncation?.reason).toBe("omitted");
    expect(failed.content.startsWith("Error: ")).toBe(true);
    expect(failed.content).toContain("reported an error");
    // 短い書き込みの結果は残りに入ればそのまま
    const short = batch.fit("file_edit", "Edited /tmp/a.txt (1 replacement)");
    expect(short.content).toBe("Edited /tmp/a.txt (1 replacement)");
    expect(batch.usedTokens).toBeLessThanOrEqual(8_192);
  });

  it("応答の呼び出しの数より多く入れようとしたら例外 (残しておく分の計算が崩れるため)", () => {
    const batch = new ToolResultBatch(limits, names(1));
    batch.fit("bash", "ok");
    expect(() => batch.fit("bash", "ok")).toThrow(/応答の呼び出しの数 \(1\) より多く/);
  });

  it("同じ順に入れれば同じ結果になる (並列で終わる順によらず、 入れる順で決まる)", () => {
    const inputs = [asciiBody(30_000), "short", wideBody(5_000), asciiBody(9_000), asciiBody(50_000)];
    const run = () => {
      const batch = new ToolResultBatch(limits, names(inputs.length));
      return inputs.map((t) => batch.fit("bash", t).content);
    };
    expect(run()).toEqual(run());
  });
});

describe("呼び出しが極端に多い応答 (§4.3 の計算)", () => {
  /** 引数の無い最小の呼び出し 1 件の出力 (Qwen 系のテンプレートで約 9 トークン) */
  const MIN_CALL_OUTPUT_TOKENS = 9;

  it.each([
    "T1",
    "T2",
    "T3",
  ] as const)("%s: 出力上限 O で出せる最大の呼び出し数でも、 注記だけで T を超えない", (tier) => {
    const b = TIER_CONTEXT_BUDGETS[tier];
    const maxCalls = Math.floor(b.outputTokenLimit / MIN_CALL_OUTPUT_TOKENS);
    const limits = { perResultTokens: b.toolResultLimitTokens, totalTokens: b.toolResultTotalTokens };
    const batch = new ToolResultBatch(
      limits,
      Array.from({ length: maxCalls }, () => "todo_append"),
    );
    expect(batch.overflow).toBe(false);
    const fits = Array.from({ length: maxCalls }, (_, i) =>
      batch.fit("todo_append", i % 2 === 0 ? asciiBody(1_000) : "Error: bad arguments"),
    );
    expect(batch.usedTokens).toBe(costOf(fits));
    expect(batch.usedTokens).toBeLessThanOrEqual(b.toolResultTotalTokens);
    // 失敗の成否は省いても残る
    for (const [i, f] of fits.entries()) expect(f.content.startsWith("Error: ")).toBe(i % 2 === 1);
  });

  it("通常の短い注記では T を超える数なら、 さらに短い注記 (ok / Error: ) にして T に収める", () => {
    const limits = { perResultTokens: 5_120, totalTokens: 24_576 };
    const n = 3_640; // T2 の O (32,768) ÷ 9
    const batch = new ToolResultBatch(
      limits,
      Array.from({ length: n }, () => "todo_append"),
    );
    const fits = Array.from({ length: n }, () => batch.fit("todo_append", asciiBody(1_000)));
    const brief = fits.filter((f) => f.truncation?.reason === "omitted" && !f.content.includes("[Result omitted"));
    expect(brief.length).toBeGreaterThan(3_000);
    for (const f of brief) expect(f.content).toBe(BRIEF_OMISSION_NOTES[1].ok);
    expect(fits.some((f) => f.content.includes(`shown only as "ok" (success) or "Error:" (error)`))).toBe(true);
    expect(batch.usedTokens).toBeLessThanOrEqual(24_576);
    expect(batch.overflow).toBe(false);
  });

  it("それでも入らない数 (作りの上では起きない) は overflow を立て、 結果は全部の呼び出しに 1 件ずつ返す", () => {
    const limits = { perResultTokens: 2_048, totalTokens: 8_192 };
    const n = 3_000;
    const batch = new ToolResultBatch(
      limits,
      Array.from({ length: n }, () => "bash"),
    );
    expect(batch.overflow).toBe(true);
    const fits = Array.from({ length: n }, () => batch.fit("bash", "done"));
    expect(fits).toHaveLength(n);
    expect(batch.summary().overflow).toBe(true);
    expect(batch.usedTokens).toBeGreaterThan(8_192);
  });
});

describe("実機の 397 件の応答 (2026-10-26。 T2: 1 件 5,120 / T 24,576)", () => {
  it("todo_append 395 件・bash 2 件、 結果の本文 約 40 万字でも、 合計は T 以下", () => {
    const b = TIER_CONTEXT_BUDGETS.T2;
    const names = ["bash", "bash", ...Array.from({ length: 395 }, () => "todo_append")];
    const batch = new ToolResultBatch(
      { perResultTokens: b.toolResultLimitTokens, totalTokens: b.toolResultTotalTokens },
      names,
    );
    const fits = names.map((n, i) =>
      batch.fit(n, i < 2 ? `Error: Exit code: 127\n${"x".repeat(800)}` : asciiBody(1_020)),
    );
    expect(batch.usedTokens).toBeLessThanOrEqual(b.toolResultTotalTokens);
    expect(fits.filter((f) => f.truncation?.reason === "omitted").length).toBeGreaterThan(300);
  });
});

describe("ティアの値", () => {
  it("T1 8,192 / T2 5,120 / T3 2,048 トークン、 合計 T は 1 件の上限以上", () => {
    for (const tier of ["T1", "T2", "T3"] as const) {
      const b = TIER_CONTEXT_BUDGETS[tier];
      expect(b.toolResultTotalTokens).toBeGreaterThanOrEqual(b.toolResultLimitTokens);
      expect(b.toolResultLimitTokens).toBeGreaterThan(MIN_TOOL_RESULT_TOKENS);
    }
  });
});
