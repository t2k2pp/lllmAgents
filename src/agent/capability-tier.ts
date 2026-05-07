/**
 * 能力ティア (capability tier) — LLM の能力レベル別ハーネス挙動の基盤。
 *
 * docs/multi-tier-harness-roadmap.md §3 の実装。
 *
 * 核心: ハーネス工学は LLM の能力ティアに適応する。 賢い LLM (T1) のための
 * 工夫が弱い LLM (T3) の足枷にならず、 逆も然り。 各機能は this.capability を
 * 参照して挙動を切り替える。
 *
 * 使い方:
 *   const cap = resolveCapability("claude-opus-4-7"); // → tier=T1
 *   const cap = resolveCapability("llama-3.2-7b");    // → tier=T3
 *   const cap = resolveCapability("my-custom",
 *     undefined, { tier: "T2", contextWindow: 32_000 }); // user override
 */

export type Tier = "T1" | "T2" | "T3";

export interface CapabilityProfile {
  /** 能力ティア。 ハーネス挙動の主軸 */
  tier: Tier;
  /** モデルのコンテキストウィンドウ (token 数) */
  contextWindow: number;
  /** ツール呼び出しの実装方式。 native = OpenAI 互換 function calling、 regex-fallback は ChatML/Mistral 等の生形式 */
  supportsToolCalling: "native" | "json-mode" | "regex-fallback";
  /** 並列ツール呼び出しを安定して扱えるか */
  supportsParallelTools: boolean;
  /** 「register: standard」 など system-prompt の規約を守れるか */
  reliableInstructionFollowing: boolean;
  /** system prompt / tool description のスタイル */
  promptStyle: "concise" | "standard" | "verbose+examples";
  /** 判定の根拠 (ログ/UI 表示用) */
  reason: string;
}

/**
 * ユーザによる手動 override の形 (~/.localllm/config.json の models[modelId])。
 * 自動判定が誤る fine-tune 等のために、 個別フィールドのみ上書き可能にする。
 */
export interface CapabilityOverride {
  tier?: Tier;
  contextWindow?: number;
  supportsToolCalling?: CapabilityProfile["supportsToolCalling"];
  supportsParallelTools?: boolean;
  reliableInstructionFollowing?: boolean;
  promptStyle?: CapabilityProfile["promptStyle"];
}

/** 各ティアのデフォルトプロファイル (override 適用前のベース) */
const TIER_DEFAULTS: Record<Tier, Omit<CapabilityProfile, "tier" | "contextWindow" | "reason">> = {
  T1: {
    supportsToolCalling: "native",
    supportsParallelTools: true,
    reliableInstructionFollowing: true,
    promptStyle: "concise",
  },
  T2: {
    supportsToolCalling: "native",
    supportsParallelTools: true,
    reliableInstructionFollowing: true,
    promptStyle: "standard",
  },
  T3: {
    supportsToolCalling: "json-mode",
    supportsParallelTools: false,
    reliableInstructionFollowing: false,
    promptStyle: "verbose+examples",
  },
};

/**
 * 既知モデル ID の完全一致テーブル。
 * キーは小文字化済 (resolve 時に lowercase 比較)。
 */
const KNOWN_MODELS: Record<string, Partial<CapabilityProfile> & { tier: Tier; contextWindow: number }> = {
  // T1: Claude 4.X / GPT-5 / Gemini 2.5 Pro
  "claude-opus-4-7": { tier: "T1", contextWindow: 200_000 },
  "claude-opus-4-7[1m]": { tier: "T1", contextWindow: 1_000_000 },
  "claude-opus-4-6": { tier: "T1", contextWindow: 200_000 },
  "claude-opus-4-5": { tier: "T1", contextWindow: 200_000 },
  "claude-sonnet-4-6": { tier: "T1", contextWindow: 200_000 },
  "claude-sonnet-4-5": { tier: "T1", contextWindow: 200_000 },
  "gpt-5": { tier: "T1", contextWindow: 200_000 },
  "gpt-5.3": { tier: "T1", contextWindow: 200_000 },
  "gpt-5.3-codex": { tier: "T1", contextWindow: 200_000 },
  "gpt-5.4": { tier: "T1", contextWindow: 200_000 },
  "gpt-4.5": { tier: "T1", contextWindow: 128_000 },
  "gemini-2.5-pro": { tier: "T1", contextWindow: 1_000_000 },

  // T2: 中堅 (Haiku, GPT-4o, Kimi, Qwen 32B+, Llama 70B+, Mistral Large, DeepSeek)
  "claude-haiku-4-5": { tier: "T2", contextWindow: 200_000 },
  "claude-haiku-4-5-20251001": { tier: "T2", contextWindow: 200_000 },
  "claude-3.5-sonnet": { tier: "T2", contextWindow: 200_000 },
  "claude-3-5-sonnet": { tier: "T2", contextWindow: 200_000 },
  "gpt-4o": { tier: "T2", contextWindow: 128_000 },
  "gpt-4-turbo": { tier: "T2", contextWindow: 128_000 },
  "kimi-k2": { tier: "T2", contextWindow: 256_000 },
  "kimi-k2.6": { tier: "T2", contextWindow: 256_000 },
  "qwen3-32b": { tier: "T2", contextWindow: 32_768 },
  "qwen3.6-35b-a3b": { tier: "T2", contextWindow: 32_768, supportsToolCalling: "native" },
  "qwen3.6-35b-a3b-bf16.gguf": { tier: "T2", contextWindow: 32_768, supportsToolCalling: "native" },
  "llama-3.3-70b": { tier: "T2", contextWindow: 128_000 },
  "llama-3.1-70b": { tier: "T2", contextWindow: 128_000 },
  "mistral-large": { tier: "T2", contextWindow: 128_000 },
  "mistral-large-2407": { tier: "T2", contextWindow: 128_000 },
  "deepseek-v3": { tier: "T2", contextWindow: 64_000 },
  "deepseek-r1": { tier: "T2", contextWindow: 64_000 },

  // T3: 小型ローカル (7B-14B, Phi 系, Gemma 小型)
  "llama-3.2-7b": { tier: "T3", contextWindow: 8_192, supportsToolCalling: "regex-fallback" },
  "llama-3.2-8b": { tier: "T3", contextWindow: 8_192, supportsToolCalling: "regex-fallback" },
  "llama-3.1-8b": { tier: "T3", contextWindow: 128_000 }, // Llama 3.1 8B は ctx 広いが知能は T3
  "mistral-7b": { tier: "T3", contextWindow: 8_192, supportsToolCalling: "regex-fallback" },
  "mistral-7b-instruct": { tier: "T3", contextWindow: 32_768, supportsToolCalling: "regex-fallback" },
  "qwen-7b": { tier: "T3", contextWindow: 32_768 },
  "qwen-14b": { tier: "T3", contextWindow: 32_768 },
  "qwen2.5-7b": { tier: "T3", contextWindow: 32_768 },
  "qwen2.5-14b": { tier: "T3", contextWindow: 32_768 },
  "phi-4": { tier: "T3", contextWindow: 16_384 },
  "phi-4-mini": { tier: "T3", contextWindow: 16_384 },
  "phi-3.5": { tier: "T3", contextWindow: 128_000 }, // ctx 広いが知能 T3
  "gemma-2-9b": { tier: "T3", contextWindow: 8_192 },
  "gemma-2-7b": { tier: "T3", contextWindow: 8_192 },
  "codellama-7b": { tier: "T3", contextWindow: 16_384 },
  "codellama-13b": { tier: "T3", contextWindow: 16_384 },
};

/**
 * プレフィックス/部分一致による fallback。 KNOWN_MODELS に完全一致がない場合に使う。
 * 順序が重要 (上から評価、 最初にマッチしたものを採用)。
 */
const PATTERN_RULES: Array<{
  pattern: RegExp;
  tier: Tier;
  contextWindow?: number;
  reason: string;
  override?: Partial<CapabilityProfile>;
}> = [
  // T1: Claude Opus / Sonnet 4.X
  { pattern: /^claude-(opus|sonnet)-4/i, tier: "T1", contextWindow: 200_000, reason: "Claude 4.X (Anthropic flagship)" },
  // T1: GPT-5 系
  { pattern: /^gpt-5/i, tier: "T1", contextWindow: 200_000, reason: "GPT-5 系 (OpenAI flagship)" },
  // T1: Gemini 2.5 Pro
  { pattern: /^gemini-2\.5-pro/i, tier: "T1", contextWindow: 1_000_000, reason: "Gemini 2.5 Pro" },
  // T2: Claude Haiku 4.5 / 3.5 Sonnet
  { pattern: /^claude-haiku-4|^claude-3\.?5-sonnet/i, tier: "T2", contextWindow: 200_000, reason: "Claude 中堅 (Haiku 4.5 / 3.5 Sonnet)" },
  // T2: GPT-4o / GPT-4-turbo
  { pattern: /^gpt-4o|^gpt-4-turbo|^gpt-4\.5/i, tier: "T2", contextWindow: 128_000, reason: "GPT-4o / 4-turbo" },
  // T2: Kimi-K2 系
  { pattern: /^kimi-k2/i, tier: "T2", contextWindow: 256_000, reason: "Kimi K2 系" },
  // T2: Qwen3 32B+ (3.x で 32B 以上)
  { pattern: /^qwen3.*-?(32b|35b|72b|110b|a3b)/i, tier: "T2", contextWindow: 32_768, reason: "Qwen3 32B+ (中堅 MoE 含む)" },
  // T2: Llama 3.x 70B+
  { pattern: /^llama-3\.?\d-70b|^llama-3\.?\d-405b/i, tier: "T2", contextWindow: 128_000, reason: "Llama 3.x 70B+" },
  // T2: Mistral Large
  { pattern: /^mistral-large/i, tier: "T2", contextWindow: 128_000, reason: "Mistral Large" },
  // T2: DeepSeek V3 / R1 系
  { pattern: /^deepseek-(v3|r1)/i, tier: "T2", contextWindow: 64_000, reason: "DeepSeek V3 / R1" },
  // T3: Llama 7B/8B/13B
  { pattern: /^llama-3\.?\d-(7b|8b|13b)|^llama-2-(7b|13b)/i, tier: "T3", contextWindow: 8_192, reason: "Llama 7-13B 小型" },
  // T3: Mistral 7B
  { pattern: /^mistral-7b/i, tier: "T3", contextWindow: 32_768, reason: "Mistral 7B 系" },
  // T3: Qwen 7B/14B
  { pattern: /^qwen2?\.?\d?-?(7b|14b|0\.5b|1\.5b|3b)/i, tier: "T3", contextWindow: 32_768, reason: "Qwen 小型 (≤14B)" },
  // T3: Phi-4 / Phi-3.5
  { pattern: /^phi-(3\.5|4)/i, tier: "T3", contextWindow: 16_384, reason: "Phi 系" },
  // T3: Gemma 7B/9B
  { pattern: /^gemma-2?-?(7b|9b|2b)/i, tier: "T3", contextWindow: 8_192, reason: "Gemma 小型" },
  // T3: Code Llama 7B/13B
  { pattern: /^codellama-(7b|13b)/i, tier: "T3", contextWindow: 16_384, reason: "Code Llama 7B/13B" },
  // T3: Granite 系の小型
  { pattern: /^granite.*-?(7b|8b|13b)/i, tier: "T3", contextWindow: 8_192, reason: "Granite 小型" },
];

/**
 * モデル ID と オプションのコンテキスト窓から能力プロファイルを解決する。
 *
 * 解決順序:
 *   1. KNOWN_MODELS (完全一致、 lowercase 比較)
 *   2. PATTERN_RULES (プレフィックス/部分一致)
 *   3. ヒューリスティック (パラメータ数推定 + ctx 窓)
 *   4. unknown フォールバック (T2 扱い、 中庸の挙動)
 *
 * @param modelId - LLM モデルの識別子 (例: "claude-opus-4-7", "gpt-5.4", "llama-3.2-7b")
 * @param ctxWindow - 既知のコンテキスト窓 (provider が報告する値があればそれを優先)
 * @param override - ユーザ設定による override (config.json の models[modelId])
 */
export function resolveCapability(
  modelId: string,
  ctxWindow?: number,
  override?: CapabilityOverride,
): CapabilityProfile {
  const id = modelId.toLowerCase().trim();

  // 1. 完全一致
  if (KNOWN_MODELS[id]) {
    const entry = KNOWN_MODELS[id];
    const base = TIER_DEFAULTS[entry.tier];
    // entry の contextWindow は base/spread で上書きされてはならないので、
    // spread 後に明示的な代入で「引数 ctxWindow > entry.contextWindow」 を確定させる
    const profile: CapabilityProfile = {
      ...base,
      ...filterUndefined(entry),
      tier: entry.tier,
      contextWindow: ctxWindow ?? entry.contextWindow,
      reason: `known model: ${modelId}`,
    };
    return applyOverride(profile, override);
  }

  // 2. パターン一致
  for (const rule of PATTERN_RULES) {
    if (rule.pattern.test(id)) {
      const base = TIER_DEFAULTS[rule.tier];
      const profile: CapabilityProfile = {
        ...base,
        ...filterUndefined(rule.override ?? {}),
        tier: rule.tier,
        contextWindow: ctxWindow ?? rule.contextWindow ?? guessContextWindowByTier(rule.tier),
        reason: `pattern match: ${rule.reason}`,
      };
      return applyOverride(profile, override);
    }
  }

  // 3. ヒューリスティック: ctxWindow から推定
  if (ctxWindow !== undefined) {
    const heuristicTier = inferTierFromContext(ctxWindow, id);
    const base = TIER_DEFAULTS[heuristicTier];
    const profile: CapabilityProfile = {
      ...base,
      tier: heuristicTier,
      contextWindow: ctxWindow,
      reason: `heuristic from ctxWindow=${ctxWindow}`,
    };
    return applyOverride(profile, override);
  }

  // 4. フォールバック: T2 中庸 (情報が無さすぎる時の安全側)
  const fallback: CapabilityProfile = {
    ...TIER_DEFAULTS.T2,
    tier: "T2",
    contextWindow: 32_768,
    reason: "fallback: unknown model, defaulting to T2 (medium)",
  };
  return applyOverride(fallback, override);
}

function filterUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function applyOverride(
  profile: CapabilityProfile,
  override?: CapabilityOverride,
): CapabilityProfile {
  if (!override) return profile;
  const cleaned = filterUndefined(override as Record<string, unknown>);
  if (Object.keys(cleaned).length === 0) return profile;
  // tier が override されたら base defaults も更新する
  if (override.tier && override.tier !== profile.tier) {
    const newBase = TIER_DEFAULTS[override.tier];
    return {
      ...profile,
      ...newBase,
      ...cleaned,
      tier: override.tier,
      reason: `${profile.reason} → user override (tier=${override.tier})`,
    };
  }
  return {
    ...profile,
    ...cleaned,
    reason: `${profile.reason} → user override`,
  };
}

/**
 * ティアからデフォルトの ctx 窓を推測 (パターン一致時の fallback)。
 */
function guessContextWindowByTier(tier: Tier): number {
  switch (tier) {
    case "T1": return 200_000;
    case "T2": return 32_768;
    case "T3": return 8_192;
  }
}

/**
 * モデル名と ctxWindow から推定。 model 名にパラメータ数表記があれば優先。
 * (例: "my-custom-llm-32b" → T2 / "tiny-7b" → T3)
 */
function inferTierFromContext(ctxWindow: number, modelId: string): Tier {
  // モデル名のパラメータ数ヒント
  const sizeMatch = modelId.match(/(\d+)\s*b\b/i);
  if (sizeMatch) {
    const billions = parseInt(sizeMatch[1], 10);
    if (billions >= 70) return "T2"; // 70B 以上は中堅相当
    if (billions <= 14) return "T3"; // 14B 以下は小型
    // 15-69B は ctx で判断
  }
  // ctx 窓のみからの推定 (おおまかな目安)
  if (ctxWindow >= 100_000) return "T2"; // 100K+ は中堅以上の可能性大
  if (ctxWindow <= 16_000) return "T3"; // 16K 以下は小型
  return "T2"; // 中庸
}

/**
 * 表示用の短いラベル ("T1 / Claude 4.X / 200K ctx" 等)。
 * /capability コマンド・起動時ログで使う。
 */
export function formatCapabilityLabel(profile: CapabilityProfile, modelId: string): string {
  const ctxK = profile.contextWindow >= 1000
    ? `${Math.round(profile.contextWindow / 1000)}K`
    : `${profile.contextWindow}`;
  return `${profile.tier} / ${modelId} / ${ctxK} ctx / ${profile.promptStyle}`;
}
