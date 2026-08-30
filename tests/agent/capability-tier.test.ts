import { describe, it, expect } from "vitest";
import { resolveCapability, formatCapabilityLabel, type Tier } from "../../src/agent/capability-tier.js";

describe("resolveCapability — 完全一致テーブル", () => {
  const cases: Array<[string, Tier, string]> = [
    // T1
    ["claude-opus-4-7", "T1", "Claude Opus 4.7"],
    ["claude-opus-4-7[1m]", "T1", "Claude Opus 4.7 1M ctx variant"],
    ["claude-sonnet-4-6", "T1", "Claude Sonnet 4.6"],
    ["gpt-5", "T1", "GPT-5 base"],
    ["gpt-5.4", "T1", "GPT-5.4"],
    ["gpt-5.3-codex", "T1", "GPT-5.3 Codex"],
    ["gemini-2.5-pro", "T1", "Gemini 2.5 Pro"],
    // T2
    ["claude-haiku-4-5", "T2", "Claude Haiku 4.5"],
    ["gpt-4o", "T2", "GPT-4o"],
    ["kimi-k2", "T2", "Kimi K2"],
    ["kimi-k2.6", "T2", "Kimi K2.6"],
    ["qwen3.6-35b-a3b", "T2", "Qwen3.6 35B A3B"],
    ["llama-3.3-70b", "T2", "Llama 3.3 70B"],
    ["mistral-large", "T2", "Mistral Large"],
    ["deepseek-v3", "T2", "DeepSeek V3"],
    // T3
    ["llama-3.2-7b", "T3", "Llama 3.2 7B"],
    ["mistral-7b", "T3", "Mistral 7B"],
    ["qwen-7b", "T3", "Qwen 7B"],
    ["phi-4", "T3", "Phi-4"],
    ["phi-4-mini", "T3", "Phi-4 mini"],
    ["gemma-2-9b", "T3", "Gemma 2 9B"],
    ["codellama-7b", "T3", "Code Llama 7B"],
  ];

  for (const [modelId, expectedTier, description] of cases) {
    it(`${modelId} → ${expectedTier} (${description})`, () => {
      const profile = resolveCapability(modelId, 128_000);
      expect(profile.tier).toBe(expectedTier);
      expect(profile.contextWindow).toBeGreaterThan(0);
    });
  }

  it("大文字混在でも一致する (lowercase 比較)", () => {
    expect(resolveCapability("Claude-Opus-4-7").tier).toBe("T1");
    expect(resolveCapability("GPT-5.4").tier).toBe("T1");
    expect(resolveCapability("LLAMA-3.2-7B").tier).toBe("T3");
  });

  it("Qwen3.6-35B-A3B-BF16.gguf (実セッションで観測した名前) → T2", () => {
    const profile = resolveCapability("Qwen3.6-35B-A3B-BF16.gguf");
    expect(profile.tier).toBe("T2");
  });
});

describe("resolveCapability — パターン一致 (PATTERN_RULES)", () => {
  it("未知の Claude 4.X variant → T1", () => {
    const profile = resolveCapability("claude-opus-4-99-experimental");
    expect(profile.tier).toBe("T1");
    expect(profile.reason).toContain("pattern match");
  });

  it("未知の GPT-5 variant → T1", () => {
    const profile = resolveCapability("gpt-5.7-preview");
    expect(profile.tier).toBe("T1");
  });

  it("Kimi-K2 系 (バリアント) → T2", () => {
    const profile = resolveCapability("kimi-k2-instruct");
    expect(profile.tier).toBe("T2");
  });

  it("Llama 70B+ 全般 → T2", () => {
    expect(resolveCapability("llama-3.1-70b-instruct").tier).toBe("T2");
    expect(resolveCapability("llama-3.3-405b").tier).toBe("T2");
  });

  it("Llama 7B/8B → T3", () => {
    expect(resolveCapability("llama-3.2-7b-instruct").tier).toBe("T3");
    expect(resolveCapability("llama-3.1-8b").tier).toBe("T3");
  });

  it("Phi-3.5 / Phi-4 系 → T3", () => {
    expect(resolveCapability("phi-3.5-mini").tier).toBe("T3");
    expect(resolveCapability("phi-4-medium").tier).toBe("T3");
  });
});

describe("resolveCapability — ヒューリスティック (パターン外)", () => {
  // tier 判定はモデル名のサイズ表記のみ使う (ctxWindow とは独立)。
  // ctxWindow の解決は providers/utils/context-length.ts (inferContextLength) に一元化済。

  it("model 名に 70b 表記があれば、明示ctxを使って T2", () => {
    const profile = resolveCapability("custom-model-70b-merged", 32_768);
    expect(profile.tier).toBe("T2");
    expect(profile.contextWindow).toBeGreaterThan(0); // 値の出所は問わない
  });

  it("model 名に 7b 表記があれば、明示ctxを使って T3", () => {
    const profile = resolveCapability("custom-fine-tune-7b-v2", 32_768);
    expect(profile.tier).toBe("T3");
  });

  it("引数 ctxWindow が指定されればそれが contextWindow に反映される (= 真値は外部由来)", () => {
    const profile = resolveCapability("custom-model-70b", 100_000);
    expect(profile.tier).toBe("T2");
    expect(profile.contextWindow).toBe(100_000);
    expect(profile.reason).toContain("ctx=arg");
  });

  it("ctxWindow 未指定で既知パターンに合えば inferContextLength が使われる", () => {
    // "llama" は inferContextLength で 128K (3.x default) になる
    const profile = resolveCapability("llama-3.2-something", undefined, { tier: "T3" });
    expect(profile.contextWindow).toBe(128_000);
    expect(profile.reason).toContain("ctx=infer");
  });

  it("ctxWindow 未指定で完全未知なら推測値へ置換せず停止する", () => {
    expect(() => resolveCapability("opaque-private-model")).toThrow("contextWindow を確定できません");
  });

  it("contextWindow だけ既知でも未知モデルの tier を T2 に自動置換しない", () => {
    expect(() => resolveCapability("opaque-private-model", 32_768)).toThrow("能力tierを自動判定できません");
  });

  it("未知モデルは明示した contextWindow と tier なら解決できる", () => {
    const profile = resolveCapability("opaque-private-model", undefined, { contextWindow: 48_000, tier: "T3" });
    expect(profile.contextWindow).toBe(48_000);
    expect(profile.tier).toBe("T3");
    expect(profile.reason).toContain("explicit tier=T3");
  });
});

describe("resolveCapability — ユーザ override", () => {
  it("tier の override が反映される (= デフォルトも切替)", () => {
    const profile = resolveCapability("claude-opus-4-7", undefined, { tier: "T3" });
    expect(profile.tier).toBe("T3");
    // T3 のデフォルトに合わせて promptStyle も切替わる
    expect(profile.promptStyle).toBe("verbose+examples");
    expect(profile.reason).toContain("user override");
  });

  it("contextWindow のみ override しても tier は維持", () => {
    const profile = resolveCapability("gpt-5.4", undefined, { contextWindow: 50_000 });
    expect(profile.tier).toBe("T1");
    expect(profile.contextWindow).toBe(50_000);
  });

  it("promptStyle のみ override (実験用)", () => {
    const profile = resolveCapability("llama-3.2-7b", undefined, { promptStyle: "concise" });
    expect(profile.tier).toBe("T3"); // tier は維持
    expect(profile.promptStyle).toBe("concise"); // override 反映
  });

  it("provider 報告の ctxWindow が override より優先される (= 引数の ctxWindow)", () => {
    const profile = resolveCapability("claude-opus-4-7", 80_000);
    expect(profile.contextWindow).toBe(80_000);
  });
});

describe("formatCapabilityLabel", () => {
  it("ティア / モデル / ctx / promptStyle が含まれる", () => {
    const profile = resolveCapability("claude-opus-4-7");
    const label = formatCapabilityLabel(profile, "claude-opus-4-7");
    expect(label).toContain("T1");
    expect(label).toContain("claude-opus-4-7");
    expect(label).toContain("200K");
    expect(label).toContain("concise");
  });

  it("ctx が K 表記 (>=1000) なら K 単位で出力", () => {
    // phi-4 は inferContextLength で 128K になる (= /phi-?4/ がマッチ)
    const profile = resolveCapability("phi-4");
    const label = formatCapabilityLabel(profile, "phi-4");
    expect(label).toMatch(/\dK ctx/); // 128K でも 200K でも何 K でも OK
  });
});

describe("CapabilityProfile — フィールド整合性", () => {
  it("T1 はデフォルトで native tool calling + 並列対応", () => {
    const profile = resolveCapability("claude-opus-4-7");
    expect(profile.supportsToolCalling).toBe("native");
    expect(profile.supportsParallelTools).toBe(true);
    expect(profile.reliableInstructionFollowing).toBe(true);
  });

  it("T3 はデフォルトで json-mode + 並列なし + verbose+examples", () => {
    const profile = resolveCapability("phi-4");
    expect(profile.supportsToolCalling).toBe("json-mode");
    expect(profile.supportsParallelTools).toBe(false);
    expect(profile.reliableInstructionFollowing).toBe(false);
    expect(profile.promptStyle).toBe("verbose+examples");
  });

  it("T2 はバランス型", () => {
    const profile = resolveCapability("kimi-k2.6");
    expect(profile.tier).toBe("T2");
    expect(profile.supportsToolCalling).toBe("native");
    expect(profile.supportsParallelTools).toBe(true);
    expect(profile.promptStyle).toBe("standard");
  });

  it("regex-fallback ツール呼出のモデルは正しく識別される", () => {
    const profile = resolveCapability("mistral-7b");
    expect(profile.supportsToolCalling).toBe("regex-fallback");
  });
});

describe("Phase C tunables — ループ制御チューナブル", () => {
  it("T1 のループ制御値: 100 反復 / self-check 3 / 0.7 / 20KB / keepRecent 10", () => {
    const p = resolveCapability("claude-opus-4-7");
    expect(p.maxIterations).toBe(100);
    expect(p.maxSelfCheckRounds).toBe(3);
    expect(p.compressionThreshold).toBe(0.7);
    expect(p.toolResultTruncateBytes).toBe(20 * 1024);
    expect(p.keepRecentMessages).toBe(10);
  });

  it("T2 のループ制御値: 80 反復 / self-check 2 / 0.6 / 12KB / keepRecent 8", () => {
    const p = resolveCapability("kimi-k2.6");
    expect(p.maxIterations).toBe(80);
    expect(p.maxSelfCheckRounds).toBe(2);
    expect(p.compressionThreshold).toBe(0.6);
    expect(p.toolResultTruncateBytes).toBe(12 * 1024);
    expect(p.keepRecentMessages).toBe(8);
  });

  it("T3 のループ制御値: 50 反復 / self-check 1 / 0.5 / 6KB / keepRecent 5", () => {
    const p = resolveCapability("phi-4");
    expect(p.maxIterations).toBe(50);
    expect(p.maxSelfCheckRounds).toBe(1);
    expect(p.compressionThreshold).toBe(0.5);
    expect(p.toolResultTruncateBytes).toBe(6 * 1024);
    expect(p.keepRecentMessages).toBe(5);
  });

  it("P1-A/B のティア別 ON/OFF: P1-A は全 tier OFF (2026-05-09)、 P1-B は T2 のみ ON", () => {
    // P1-A bash 累積警告: 全 tier 既定 OFF (誤発火 + 作業中断副作用のため)
    expect(resolveCapability("claude-opus-4-7").bashCumulativeWarnEnabled).toBe(false);
    expect(resolveCapability("kimi-k2.6").bashCumulativeWarnEnabled).toBe(false);
    expect(resolveCapability("phi-4").bashCumulativeWarnEnabled).toBe(false);
    // P1-B plan/todo 過多検知: T1=OFF (賢いLLMの足枷回避) / T2=ON / T3=OFF (scaffolding抑制)
    expect(resolveCapability("claude-opus-4-7").planTodoOveruseEnabled).toBe(false);
    expect(resolveCapability("kimi-k2.6").planTodoOveruseEnabled).toBe(true);
    expect(resolveCapability("phi-4").planTodoOveruseEnabled).toBe(false);
  });

  it("ユーザ override で tunables を個別に変更可能", () => {
    const p = resolveCapability("claude-opus-4-7", undefined, {
      maxIterations: 200,
      compressionThreshold: 0.85,
    });
    expect(p.tier).toBe("T1"); // tier は維持
    expect(p.maxIterations).toBe(200); // override 反映
    expect(p.compressionThreshold).toBe(0.85);
    expect(p.maxSelfCheckRounds).toBe(3); // 他のフィールドは T1 default
  });

  it("tier override で tunables も対応する tier の値に切替", () => {
    const p = resolveCapability("claude-opus-4-7", undefined, { tier: "T3" });
    expect(p.tier).toBe("T3");
    expect(p.maxIterations).toBe(50); // T3 の default
    expect(p.compressionThreshold).toBe(0.5);
  });
});
