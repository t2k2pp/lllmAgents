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
 *
 * 設計判断 (2026-05-07 の認識訂正):
 *   - **contextWindow は Tier 判定の入力ではなく、 出力フィールド**。
 *     - 真値は config / provider.getModelInfo / 既知モデル名の推論で決め、
 *       確定できなければ明示設定を要求する
 *     - resolveCapability の引数 ctxWindow にそれが渡って来る前提
 *     - ctxWindow 未指定時の既知モデル名推論は inferContextLength に委譲し、
 *       capability-tier 内に独自のテーブルを持たない (= 重複層を作らない)
 *   - tier 判定はモデル名の一致のみ。 contextWindow は判定に使わない。
 */
import { inferContextLength } from "../providers/utils/context-length.js";

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

  // === Phase C: ループ制御チューナブル (docs/multi-tier-harness-roadmap.md §4 Phase C) ===
  /** ツール呼び出しの hard cap (絶対上限) */
  maxIterations: number;
  /** 自己点検の最大連続発動回数 (text-only / verification / evaluator 共通) */
  maxSelfCheckRounds: number;
  /** ContextManager の圧縮発火閾値 (0..1, 例: 0.7 = 70% で圧縮) */
  compressionThreshold: number;
  /** 履歴格納時に tool_result を truncate する閾値 (バイト数) */
  toolResultTruncateBytes: number;
  /**
   * P1-A bash 累積警告を有効化するか。
   * 2026-05-09: 全 tier で OFF に変更。 単発で長い bash (pygame の lingering 等で
   * harness 計測 durationMs が膨らむ) で誤発火し、 警告文「重い build/run の連発」 と
   * 実態が乖離。 T1 (gpt-5.4) では警告直後に response_complete を呼んで作業を畳む
   * 副作用も観測 (jsonl 2026-05-08T15-36-24 turn28→29)。 default false を維持し、
   * 必要なユーザーが override で個別 ON にできる形に降格。
   */
  bashCumulativeWarnEnabled: boolean;
  /** P1-B plan/todo 過多検知を有効化するか (T1/T3 では抑制) */
  planTodoOveruseEnabled: boolean;
  /**
   * Phase D-4: 圧縮時に手元に残す直近メッセージ数。 短 ctx の T3 ほど少なく。
   * docs/multi-tier-harness-roadmap.md §4 Phase D-4 参照。
   */
  keepRecentMessages: number;
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
  // Phase C tunables も override 可能
  maxIterations?: number;
  maxSelfCheckRounds?: number;
  compressionThreshold?: number;
  toolResultTruncateBytes?: number;
  bashCumulativeWarnEnabled?: boolean;
  planTodoOveruseEnabled?: boolean;
  // Phase D-4
  keepRecentMessages?: number;
}

/** 各ティアのデフォルトプロファイル (override 適用前のベース) */
const TIER_DEFAULTS: Record<Tier, Omit<CapabilityProfile, "tier" | "contextWindow" | "reason">> = {
  T1: {
    supportsToolCalling: "native",
    supportsParallelTools: true,
    reliableInstructionFollowing: true,
    promptStyle: "concise",
    // Phase C: T1 は 100 反復まで深掘り、 自己点検 3 回まで、 圧縮閾値 0.7、 truncate 20KB
    maxIterations: 100,
    maxSelfCheckRounds: 3,
    compressionThreshold: 0.7,
    toolResultTruncateBytes: 20 * 1024,
    // 2026-05-09: 誤発火 + T1 が response_complete を呼んで作業を畳む副作用を観測したため OFF
    bashCumulativeWarnEnabled: false,
    // T1 は plan/todo を自然に最小限で運用するため過多検知は OFF (= 賢い LLM の足枷にしない)
    planTodoOveruseEnabled: false,
    // Phase D-4: 圧縮時に残す直近メッセージ数 (T1 は ctx 広いので余裕あり)
    keepRecentMessages: 10,
  },
  T2: {
    supportsToolCalling: "native",
    supportsParallelTools: true,
    reliableInstructionFollowing: true,
    promptStyle: "standard",
    // Phase C: T2 は 80 反復、 自己点検 2 回、 圧縮 0.6、 truncate 12KB
    maxIterations: 80,
    maxSelfCheckRounds: 2,
    compressionThreshold: 0.6,
    toolResultTruncateBytes: 12 * 1024,
    // 2026-05-09: T1 で観測した誤発火と作業中断の副作用は T2 でもリスクが高いため OFF
    bashCumulativeWarnEnabled: false,
    planTodoOveruseEnabled: true,
    keepRecentMessages: 8,
  },
  T3: {
    supportsToolCalling: "json-mode",
    supportsParallelTools: false,
    reliableInstructionFollowing: false,
    promptStyle: "verbose+examples",
    // Phase C: T3 は 50 反復で打ち切り、 自己点検 1 回、 圧縮 0.5、 truncate 6KB
    maxIterations: 50,
    maxSelfCheckRounds: 1,
    compressionThreshold: 0.5,
    toolResultTruncateBytes: 6 * 1024,
    // T3 は scaffolding 自体が判断負荷を上げるため P1-A/B は両方 OFF
    bashCumulativeWarnEnabled: false,
    planTodoOveruseEnabled: false,
    // Phase D-4: T3 は短 ctx (8K-32K) なので直近 5 件だけ残して積極的に圧縮
    keepRecentMessages: 5,
  },
};

/**
 * 既知モデル ID の完全一致テーブル (tier 判定のみ)。
 * キーは小文字化済 (resolve 時に lowercase 比較)。
 *
 * 注: contextWindow はここに持たない。 真値は呼出元 (src/index.ts) で
 * provider.getModelInfo / inferContextLength が解決し、 ctxWindow 引数として渡る。
 * ここでは tool-calling 形式や parallelTools 等の挙動指定だけ tier の base
 * からの上書きを許す。
 */
const KNOWN_MODELS: Record<string, Partial<CapabilityProfile> & { tier: Tier }> = {
  // T1: Claude 4.X / GPT-5 / Gemini 2.5 Pro
  "claude-opus-4-7": { tier: "T1" },
  "claude-opus-4-7[1m]": { tier: "T1" },
  "claude-opus-4-6": { tier: "T1" },
  "claude-opus-4-5": { tier: "T1" },
  "claude-sonnet-4-6": { tier: "T1" },
  "claude-sonnet-4-5": { tier: "T1" },
  "gpt-5": { tier: "T1" },
  "gpt-5.3": { tier: "T1" },
  "gpt-5.3-codex": { tier: "T1" },
  "gpt-5.4": { tier: "T1" },
  "gpt-4.5": { tier: "T1" },
  "gemini-2.5-pro": { tier: "T1" },

  // T2: 中堅 (Haiku, GPT-4o, Kimi, Qwen 32B+, Llama 70B+, Mistral Large, DeepSeek)
  "claude-haiku-4-5": { tier: "T2" },
  "claude-haiku-4-5-20251001": { tier: "T2" },
  "claude-3.5-sonnet": { tier: "T2" },
  "claude-3-5-sonnet": { tier: "T2" },
  "gpt-4o": { tier: "T2" },
  "gpt-4-turbo": { tier: "T2" },
  "kimi-k2": { tier: "T2" },
  "kimi-k2.6": { tier: "T2" },
  "qwen3-32b": { tier: "T2" },
  "qwen3.6-35b-a3b": { tier: "T2", supportsToolCalling: "native" },
  "qwen3.6-35b-a3b-bf16.gguf": { tier: "T2", supportsToolCalling: "native" },
  "llama-3.3-70b": { tier: "T2" },
  "llama-3.1-70b": { tier: "T2" },
  "mistral-large": { tier: "T2" },
  "mistral-large-2407": { tier: "T2" },
  "deepseek-v3": { tier: "T2" },
  "deepseek-r1": { tier: "T2" },

  // T3: 小型ローカル (7B-14B, Phi 系, Gemma 小型)。 ctx は inferContextLength 任せ。
  "llama-3.2-7b": { tier: "T3", supportsToolCalling: "regex-fallback" },
  "llama-3.2-8b": { tier: "T3", supportsToolCalling: "regex-fallback" },
  "llama-3.1-8b": { tier: "T3" }, // ctx は inferContextLength で 128K
  "mistral-7b": { tier: "T3", supportsToolCalling: "regex-fallback" },
  "mistral-7b-instruct": { tier: "T3", supportsToolCalling: "regex-fallback" },
  "qwen-7b": { tier: "T3" },
  "qwen-14b": { tier: "T3" },
  "qwen2.5-7b": { tier: "T3" },
  "qwen2.5-14b": { tier: "T3" },
  "phi-4": { tier: "T3" },
  "phi-4-mini": { tier: "T3" },
  "phi-3.5": { tier: "T3" },
  "gemma-2-9b": { tier: "T3" },
  "gemma-2-7b": { tier: "T3" },
  "codellama-7b": { tier: "T3" },
  "codellama-13b": { tier: "T3" },
};

/**
 * プレフィックス/部分一致による fallback (tier 判定のみ)。
 * KNOWN_MODELS に完全一致がない場合に使う。 順序が重要 (上から評価)。
 *
 * 注: ここも contextWindow を持たない (= inferContextLength 委譲)。
 */
const PATTERN_RULES: Array<{
  pattern: RegExp;
  tier: Tier;
  reason: string;
  override?: Partial<CapabilityProfile>;
}> = [
  // T1: Claude Opus / Sonnet 4.X
  { pattern: /^claude-(opus|sonnet)-4/i, tier: "T1", reason: "Claude 4.X (Anthropic flagship)" },
  // T1: GPT-5 系
  { pattern: /^gpt-5/i, tier: "T1", reason: "GPT-5 系 (OpenAI flagship)" },
  // T1: Gemini 2.5 Pro
  { pattern: /^gemini-2\.5-pro/i, tier: "T1", reason: "Gemini 2.5 Pro" },
  // T2: Claude Haiku 4.5 / 3.5 Sonnet
  { pattern: /^claude-haiku-4|^claude-3\.?5-sonnet/i, tier: "T2", reason: "Claude 中堅 (Haiku 4.5 / 3.5 Sonnet)" },
  // T2: GPT-4o / GPT-4-turbo
  { pattern: /^gpt-4o|^gpt-4-turbo|^gpt-4\.5/i, tier: "T2", reason: "GPT-4o / 4-turbo" },
  // T2: Kimi-K2 系
  { pattern: /^kimi-k2/i, tier: "T2", reason: "Kimi K2 系" },
  // T2: Qwen3 32B+ (3.x で 32B 以上)
  { pattern: /^qwen3.*-?(32b|35b|72b|110b|a3b)/i, tier: "T2", reason: "Qwen3 32B+ (中堅 MoE 含む)" },
  // T2: Llama 3.x 70B+
  { pattern: /^llama-3\.?\d-70b|^llama-3\.?\d-405b/i, tier: "T2", reason: "Llama 3.x 70B+" },
  // T2: Mistral Large
  { pattern: /^mistral-large/i, tier: "T2", reason: "Mistral Large" },
  // T2: DeepSeek V3 / R1 系
  { pattern: /^deepseek-(v3|r1)/i, tier: "T2", reason: "DeepSeek V3 / R1" },
  // T3: Llama 7B/8B/13B
  { pattern: /^llama-3\.?\d-(7b|8b|13b)|^llama-2-(7b|13b)/i, tier: "T3", reason: "Llama 7-13B 小型" },
  // T3: Mistral 7B
  { pattern: /^mistral-7b/i, tier: "T3", reason: "Mistral 7B 系" },
  // T3: Qwen 7B/14B
  { pattern: /^qwen2?\.?\d?-?(7b|14b|0\.5b|1\.5b|3b)/i, tier: "T3", reason: "Qwen 小型 (≤14B)" },
  // T3: Phi-4 / Phi-3.5
  { pattern: /^phi-(3\.5|4)/i, tier: "T3", reason: "Phi 系" },
  // T3: Gemma 7B/9B
  { pattern: /^gemma-2?-?(7b|9b|2b)/i, tier: "T3", reason: "Gemma 小型" },
  // T3: Code Llama 7B/13B
  { pattern: /^codellama-(7b|13b)/i, tier: "T3", reason: "Code Llama 7B/13B" },
  // T3: Granite 系の小型
  { pattern: /^granite.*-?(7b|8b|13b)/i, tier: "T3", reason: "Granite 小型" },
];

/**
 * モデル ID と オプションのコンテキスト窓から能力プロファイルを解決する。
 *
 * tier 判定 (KNOWN_MODELS / PATTERN_RULES / 名前ヒューリスティック / 明示override) と、
 * contextWindow の解決 (引数 → 明示override → inferContextLength) は
 * 直交。 後者は providers/utils/context-length.ts に一元化済 (重複層を作らない)。
 *
 * @param modelId - LLM モデルの識別子 (例: "claude-opus-4-7", "gpt-5.4", "llama-3.2-7b")
 * @param ctxWindow - 既知のコンテキスト窓 (provider が報告する値があれば呼出元から渡す)
 * @param override - ユーザ設定による override (config.json の models[modelId])
 */
export function resolveCapability(
  modelId: string,
  ctxWindow?: number,
  override?: CapabilityOverride,
): CapabilityProfile {
  const id = modelId.toLowerCase().trim();
  // contextWindow は引数/明示override → inferContextLength の順で 1 回だけ解決。
  // tier 判定とは独立しており、 KNOWN_MODELS / PATTERN_RULES は持たない。
  const resolvedCtx = resolveContextWindow(modelId, ctxWindow ?? override?.contextWindow);

  // 1. 完全一致 (tier 判定)
  if (KNOWN_MODELS[id]) {
    const entry = KNOWN_MODELS[id];
    const base = TIER_DEFAULTS[entry.tier];
    const profile: CapabilityProfile = {
      ...base,
      ...filterUndefined(entry),
      tier: entry.tier,
      contextWindow: resolvedCtx.value,
      reason: `known model: ${modelId} (ctx=${resolvedCtx.source})`,
    };
    return applyOverride(profile, override);
  }

  // 2. パターン一致 (tier 判定)
  for (const rule of PATTERN_RULES) {
    if (rule.pattern.test(id)) {
      const base = TIER_DEFAULTS[rule.tier];
      const profile: CapabilityProfile = {
        ...base,
        ...filterUndefined(rule.override ?? {}),
        tier: rule.tier,
        contextWindow: resolvedCtx.value,
        reason: `pattern match: ${rule.reason} (ctx=${resolvedCtx.source})`,
      };
      return applyOverride(profile, override);
    }
  }

  // 3. ヒューリスティック: モデル名のパラメータ数表記 (例: "-7b" → T3)
  const nameTier = inferTierFromName(id);
  if (nameTier) {
    const base = TIER_DEFAULTS[nameTier];
    const profile: CapabilityProfile = {
      ...base,
      tier: nameTier,
      contextWindow: resolvedCtx.value,
      reason: `heuristic from model name (size hint) (ctx=${resolvedCtx.source})`,
    };
    return applyOverride(profile, override);
  }

  // 4. 自動判定不能なら、ユーザーが明示した tier だけを使う。
  if (!override?.tier) {
    throw new Error(
      `未知モデル '${modelId}' の能力tierを自動判定できません。 ` +
        `config.json の modelCapabilities.${JSON.stringify(modelId)}.tier に T1/T2/T3 を明示してください。`,
    );
  }
  const explicit: CapabilityProfile = {
    ...TIER_DEFAULTS[override.tier],
    tier: override.tier,
    contextWindow: resolvedCtx.value,
    reason: `unknown model with explicit tier=${override.tier} (ctx=${resolvedCtx.source})`,
  };
  return applyOverride(explicit, override);
}

/**
 * contextWindow の真値解決。引数または明示overrideを優先し、既知モデル名だけ推論する。
 * どちらからも確定できなければ、誤った上限で実行せず設定方法を示して停止する。
 */
function resolveContextWindow(
  modelId: string,
  ctxWindow: number | undefined,
): {
  value: number;
  source: "arg" | "infer";
} {
  if (typeof ctxWindow === "number" && ctxWindow > 0) {
    return { value: ctxWindow, source: "arg" };
  }
  const inferred = inferContextLength(modelId);
  if (inferred > 0) {
    return { value: inferred, source: "infer" };
  }
  throw new Error(
    `モデル '${modelId}' の contextWindow を確定できません。 ` +
      `mainLLM.contextWindow または modelCapabilities.${JSON.stringify(modelId)}.contextWindow を明示してください。`,
  );
}

function filterUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function applyOverride(profile: CapabilityProfile, override?: CapabilityOverride): CapabilityProfile {
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
 * モデル名のパラメータ数表記 (例: "-7b", "-32b") から tier を推測。
 * 該当しない場合は null を返し、caller は明示tierを要求する。
 *
 * (旧 inferTierFromContext は ctxWindow を判定材料に使っていたが、 ctxWindow は
 * tier 判定とは独立な値であるべきため廃止。 ここでは名前情報のみ使う。)
 */
function inferTierFromName(modelId: string): Tier | null {
  const sizeMatch = modelId.match(/(\d+)\s*b\b/i);
  if (!sizeMatch) return null;
  const billions = parseInt(sizeMatch[1], 10);
  if (billions >= 70) return "T2"; // 70B 以上は中堅相当
  if (billions <= 14) return "T3"; // 14B 以下は小型
  // 15-69B (= 30B クラス MoE 等) は中庸として T2
  return "T2";
}

/**
 * 表示用の短いラベル ("T1 / Claude 4.X / 200K ctx" 等)。
 * /capability コマンド・起動時ログで使う。
 */
export function formatCapabilityLabel(profile: CapabilityProfile, modelId: string): string {
  const ctxK =
    profile.contextWindow >= 1000 ? `${Math.round(profile.contextWindow / 1000)}K` : `${profile.contextWindow}`;
  return `${profile.tier} / ${modelId} / ${ctxK} ctx / ${profile.promptStyle}`;
}
