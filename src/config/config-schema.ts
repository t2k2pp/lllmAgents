/**
 * config.json の zod スキーマ検証 (docs/production-readiness.md PR-03)。
 *
 * 方針:
 * - スキーマは「型が合っているか」の検出専用 (deep partial)。値の欠落は検証しない
 *   (欠落は loadConfig の既定値マージが埋める。必須値の案内は各機能の既存ガードが担う)
 * - 不正なフィールドだけをピンポイントで取り除き、どのキーがなぜ無効かを警告する
 *   (silent な欠損の禁止)
 * - スキーマの出力は使わない。未知のキー (将来のフィールドや手書きメモ) は
 *   z.object が黙って strip するため、元オブジェクトから不正パスだけを削る方式にする
 */
import { z } from "zod";
import type { Config } from "./types.js";

// ─── 部品スキーマ (すべて partial = 型チェックのみ) ───

const localProviders = ["ollama", "lmstudio", "llamacpp", "vllm"] as const;
const cloudProviders = [
  "vertex-ai",
  "azure-openai",
  "azure-gpt",
  "azure-claude",
  "azure-foundry",
  "azure-anthropic",
  "anthropic",
  "claude-cli",
  "claude-agent-sdk",
  "gemini",
] as const;

const llmEndpointSchema = z
  .object({
    providerType: z.enum([...localProviders, ...cloudProviders]),
    baseUrl: z.string(),
    model: z.string(),
    contextWindow: z.number(),
    projectId: z.string(),
    region: z.string(),
    endpoint: z.string(),
    apiKey: z.string(),
    deploymentName: z.string(),
    description: z.string(),
    temperature: z.number(),
    top_p: z.number(),
    top_k: z.number(),
    repetition_penalty: z.number(),
  })
  .partial();

const budgetSchema = z
  .object({
    limitUsd: z.number(),
    warningThreshold: z.number(),
    stopThreshold: z.number(),
  })
  .partial();

const secondLLMSchema = z
  .object({
    enabled: z.boolean(),
    endpoint: llmEndpointSchema,
    budget: budgetSchema.nullable(),
    cost: z.object({ referenceModels: z.array(z.string()) }).partial(),
    samplingDefaults: z
      .object({
        consultTemperature: z.number(),
        agentTemperature: z.number(),
        evaluatorTemperature: z.number(),
      })
      .partial(),
    iterationLimits: z
      .object({
        maxAgentIterations: z.number(),
        maxEvaluatorIterations: z.number(),
      })
      .partial(),
  })
  .partial();

const securitySchema = z
  .object({
    allowedDirectories: z.array(z.string()),
    blockedCommands: z.array(z.string()),
    autoApproveTools: z.array(z.string()),
    requireApprovalTools: z.array(z.string()),
    discordAutoApproveTools: z.array(z.string()),
    slackAutoApproveTools: z.array(z.string()),
    discordAutorun: z.boolean(),
    slackAutorun: z.boolean(),
    rules: z
      .object({
        allow: z.array(z.string()),
        deny: z.array(z.string()),
        ask: z.array(z.string()),
      })
      .partial(),
    streamCommandOutput: z.boolean(),
    processSandbox: z
      .object({
        enabled: z.boolean(),
        level: z.enum(["none", "fs", "network", "full"]),
        allowedHosts: z.array(z.string()),
        autoAllowBashWhenContained: z.boolean(),
      })
      .partial(),
  })
  .partial();

const pendingUserSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    firstSeen: z.string(),
    lastSeen: z.string(),
    attempts: z.number(),
  })
  .partial();

const discordSchema = z
  .object({
    enabled: z.boolean(),
    webhookUrl: z.string(),
    applicationId: z.string(),
    publicKey: z.string(),
    botToken: z.string(),
    interactionPort: z.number(),
    listenEnabled: z.boolean(),
    allowedUserIds: z.array(z.string()),
    pendingUsers: z.array(pendingUserSchema),
    interactionTimeoutSec: z.number(),
    attachGeneratedImages: z.boolean(),
    maxAttachmentMb: z.number(),
  })
  .partial();

const slackSchema = z
  .object({
    enabled: z.boolean(),
    webhookUrl: z.string(),
    botToken: z.string(),
    appToken: z.string(),
    allowedUserIds: z.array(z.string()),
    interactionTimeoutSec: z.number(),
  })
  .partial();

const imageGenProfileSchema = z
  .object({
    name: z.string(),
    providerType: z.enum(["azure-image", "sd-webui", "comfyui"]),
    endpoint: z.string(),
    apiKey: z.string(),
    model: z.string(),
    baseUrl: z.string(),
    workflowTemplate: z.string().nullable(),
    checkpoint: z.string(),
    defaultSize: z.string(),
    defaultQuality: z.enum(["low", "medium", "high"]),
    negativePrompt: z.string(),
    steps: z.number(),
  })
  .partial();

const roomIdSchema = z.enum(["A", "B", "C"]);

const roomConfigSchema = z
  .object({
    bindings: z
      .object({
        repl: roomIdSchema,
        discord: roomIdSchema,
        slack: roomIdSchema,
      })
      .partial(),
    autoResume: z
      .object({
        A: z.boolean(),
        B: z.boolean(),
        C: z.boolean(),
      })
      .partial(),
  })
  .partial();

const modelCapabilityOverrideSchema = z
  .object({
    tier: z.enum(["T1", "T2", "T3"]),
    contextWindow: z.number(),
    promptStyle: z.enum(["concise", "standard", "verbose+examples"]),
    supportsToolCalling: z.enum(["native", "json-mode", "regex-fallback"]),
    supportsParallelTools: z.boolean(),
    reliableInstructionFollowing: z.boolean(),
  })
  .partial();

/** Config 全体の deep-partial 型チェックスキーマ (検出専用) */
export const configSchema = z
  .object({
    mainLLM: llmEndpointSchema,
    visionLLM: llmEndpointSchema.nullable(),
    secondLLM: secondLLMSchema.nullable(),
    security: securitySchema,
    context: z
      .object({
        compressionThreshold: z.number(),
        maxHistoryMessages: z.number(),
      })
      .partial(),
    discord: discordSchema,
    slack: slackSchema,
    notifications: z.object({ minDurationSec: z.number() }).partial(),
    goalSeek: z.object({ autoPropose: z.boolean() }).partial(),
    search: z
      .object({
        provider: z.enum(["duckduckgo", "searxng"]),
        searxngUrl: z.string(),
      })
      .partial(),
    obsidian: z
      .object({
        vaultPath: z.string(),
        knowledgeDir: z.string(),
        defaultTags: z.array(z.string()),
      })
      .partial(),
    features: z
      .object({
        browser: z.enum(["auto", "on", "off"]),
        computerUse: z.enum(["on", "off"]),
        promptCache: z
          .object({
            enabled: z.boolean(),
            ttl: z.enum(["5m", "1h"]),
          })
          .partial(),
      })
      .partial(),
    imageGen: z
      .object({
        enabled: z.boolean(),
        active: z.string(),
        profiles: z.array(imageGenProfileSchema),
      })
      .partial(),
    streamingDisplay: z.boolean(),
    jpyPerUsd: z.number(),
    maxParallelTools: z.number(),
    autorunMode: z.boolean(),
    inputCompression: z.boolean(),
    chatLog: z
      .object({
        enabled: z.boolean(),
        vaultPath: z.string(),
      })
      .partial(),
    logging: z
      .object({
        ops: z
          .object({
            enabled: z.boolean(),
            level: z.enum(["trace", "debug", "info", "warn", "error"]),
            path: z.string(),
          })
          .partial(),
        retention: z
          .object({
            logMaxAgeDays: z.number(),
            logMaxTotalMb: z.number(),
            sessionMaxCount: z.number(),
          })
          .partial(),
      })
      .partial(),
    updateCheck: z.object({ enabled: z.boolean() }).partial(),
    modelCapabilities: z.record(z.string(), modelCapabilityOverrideSchema),
    mcpEnabled: z.boolean(),
    disabledMcpServers: z.array(z.string()),
    skillsEnabled: z.boolean(),
    disabledSkills: z.array(z.string()),
    pluginDirs: z.array(z.string()),
    checkpoints: z
      .object({
        enabled: z.boolean(),
        workTreeDir: z.string(),
        maxFileSizeMb: z.number(),
        retention: z
          .object({
            maxSessions: z.number(),
            maxAgeDays: z.number(),
          })
          .partial(),
      })
      .partial(),
    roomConfig: roomConfigSchema,
  })
  .partial();

// ─── 不正フィールドの除去 ───

/** obj から path のフィールドを取り除く。配列要素は splice。成功で true */
function removeAtPath(obj: unknown, rawPath: ReadonlyArray<PropertyKey>): boolean {
  // JSON.parse 由来のオブジェクトに symbol キーは存在しない
  if (rawPath.length === 0 || rawPath.some((p) => typeof p === "symbol")) return false;
  const path = rawPath as ReadonlyArray<string | number>;
  let parent: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (parent === null || typeof parent !== "object") return false;
    parent = (parent as Record<string | number, unknown>)[path[i]];
  }
  if (parent === null || typeof parent !== "object") return false;
  const last = path[path.length - 1];
  if (Array.isArray(parent) && typeof last === "number") {
    if (last < 0 || last >= parent.length) return false;
    parent.splice(last, 1);
    return true;
  }
  if (!(last in (parent as Record<string, unknown>))) return false;
  delete (parent as Record<string, unknown>)[last];
  return true;
}

export interface ConfigValidationResult {
  /** 不正フィールドを取り除いた設定 (未知キーは保持) */
  config: Partial<Config>;
  /** ユーザーへ表示する警告 (1件 = 取り除いた1フィールド) */
  warnings: string[];
}

/** 1回のループで直せない場合の上限 (通常は issue 数回で収束する) */
const MAX_SANITIZE_ROUNDS = 50;

/**
 * パース済み config.json をスキーマ検証し、型の合わないフィールドだけを
 * 取り除いて返す。取り除いたフィールドは警告として報告する。
 *
 * 配列要素の除去で index がずれるため、1ラウンドにつき最初の issue だけを
 * 処理して再検証するループ方式にしている (config は小さいので十分速い)。
 */
export function sanitizeParsedConfig(parsed: unknown): ConfigValidationResult {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      config: {},
      warnings: [`設定 config.json のルートがオブジェクトではないため、既定の設定で起動します。`],
    };
  }
  const cleaned = structuredClone(parsed);
  const warnings: string[] = [];

  for (let round = 0; round < MAX_SANITIZE_ROUNDS; round++) {
    const result = configSchema.safeParse(cleaned);
    if (result.success) {
      return { config: cleaned as Partial<Config>, warnings };
    }
    const issue = result.error.issues[0];
    const keyPath = issue.path.map(String).join(".") || "(root)";
    if (!removeAtPath(cleaned, issue.path)) {
      // 取り除けない issue (通常は起きない)。無限ループを避けて打ち切る
      warnings.push(
        `設定 config.json の検証で解決できない問題が残りました: ${keyPath} (${issue.message})。該当箇所を手で修正してください。`,
      );
      return { config: cleaned as Partial<Config>, warnings };
    }
    warnings.push(`設定 config.json: "${keyPath}" の値が不正なため無視し、既定値として扱います (${issue.message})。`);
  }
  warnings.push(`設定 config.json に不正な値が多すぎるため、検証を打ち切りました。--setup での再設定を推奨します。`);
  return { config: cleaned as Partial<Config>, warnings };
}
