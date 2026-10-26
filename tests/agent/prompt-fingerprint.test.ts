import { describe, expect, it } from "vitest";
import { comparePromptFingerprints, fingerprintPrompt } from "../../src/agent/prompt-fingerprint.js";

/** 送った並びの指紋 (docs/context-reduction-redesign.md §10.2) */

const tool = { type: "function", function: { name: "probe", description: "probe", parameters: {} } };
const base = {
  model: "m",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "q" },
  ],
  tools: [tool],
  stream: true,
  temperature: 0.6,
  maxTokens: 32_768,
};

describe("fingerprintPrompt", () => {
  it("設定・道具の定義・messages の 1 件ずつを 8 文字のハッシュにする。 出力上限と signal は含めない", () => {
    const f = fingerprintPrompt(base);
    expect(f.settings).toMatch(/^[0-9a-f]{8}$/);
    expect(f.tools).toMatch(/^[0-9a-f]{8}$/);
    expect(f.messages).toHaveLength(2);
    // 先読み (出力上限 1・別の signal) と本体呼び出しは同じ指紋になる
    expect(fingerprintPrompt({ ...base, maxTokens: 1, signal: new AbortController().signal })).toEqual(f);
  });

  it("道具が無ければ tools は -", () => {
    expect(fingerprintPrompt({ ...base, tools: undefined }).tools).toBe("-");
    expect(fingerprintPrompt({ ...base, tools: [] }).tools).toBe("-");
  });

  it("設定・道具・messages の違いがそれぞれの欄に出る", () => {
    const f = fingerprintPrompt(base);
    expect(fingerprintPrompt({ ...base, temperature: 0.7 }).settings).not.toBe(f.settings);
    expect(
      fingerprintPrompt({ ...base, tools: [tool, { ...tool, function: { ...tool.function, name: "x" } }] }).tools,
    ).not.toBe(f.tools);
    const changed = fingerprintPrompt({ ...base, messages: [base.messages[0], { role: "user", content: "q2" }] });
    expect(changed.messages[0]).toBe(f.messages[0]);
    expect(changed.messages[1]).not.toBe(f.messages[1]);
  });
});

describe("comparePromptFingerprints", () => {
  const prev = { settings: "s", tools: "t", messages: ["a", "b", "c"] };

  it("前の送信の messages がそのまま今回の先頭なら firstDifferentMessage は null", () => {
    expect(comparePromptFingerprints("main", prev, { ...prev, messages: ["a", "b", "c", "d"] })).toEqual({
      against: "main",
      settingsChanged: false,
      toolsChanged: false,
      firstDifferentMessage: null,
      previousMessageCount: 3,
      messageCount: 4,
    });
  });

  it("途中で違えばその位置、 今回が短ければ今回の件数", () => {
    expect(
      comparePromptFingerprints("prewarm", prev, { ...prev, messages: ["a", "x", "c", "d"] }).firstDifferentMessage,
    ).toBe(1);
    expect(comparePromptFingerprints("prewarm", prev, { ...prev, messages: ["a"] }).firstDifferentMessage).toBe(1);
  });
});
