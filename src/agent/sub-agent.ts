import path from "node:path";
import type { ChatResponse, LLMProvider, TokenUsage } from "../providers/base-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { PermissionManager } from "../security/permission-manager.js";
import { MessageHistory } from "./message-history.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { collectResponse } from "../providers/base-provider.js";
import { AgentDefinitionLoader } from "../agents/agent-loader.js";
import type { AgentDefinition } from "../agents/agent-loader.js";
import * as logger from "../utils/logger.js";
import { isStructurallyIncomplete } from "../utils/incomplete-response.js";
import {
  ROOT_ANCESTORS,
  extendAncestors,
  filterRegistryForAncestors,
  type AncestorTypes,
} from "./delegation-context.js";
import { HarnessState, enrichToolResult } from "./harness-intervention.js";
import { formatSelfCheck, SUB_AGENT_ACTION_HINT } from "./self-check-messages.js";
import { resolveModelRef } from "../config/model-resolver.js";
import { getSlot } from "../config/model-registry.js";
import { globalTokenTracker, type UsageSlot } from "../cost/token-tracker.js";
import { globalCostCalculator } from "../cost/cost-calculator.js";
import type { SkillDefinition, SkillRegistry } from "../skills/skill-registry.js";

const MAX_SUB_ITERATIONS = 30;

/** 委任1件のLLM呼出回数を必ず1..30へ収める。NaN/未指定は安全な既定30。 */
export function normalizeSubAgentMaxTurns(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_SUB_ITERATIONS;
  return Math.max(1, Math.min(MAX_SUB_ITERATIONS, Math.floor(value)));
}

export type SubAgentType = "explore" | "plan" | "general-purpose" | "bash" | (string & {});

interface SubAgentConfig {
  type: SubAgentType;
  description: string;
  systemPrompt: string;
  maxTurns?: number;
  allowedTools?: string[];
  skills?: string[];
}

// ID-014 (a) (2026-05-01): FALLBACK_CONFIGS は完全撤去。
// 全エージェント定義は src/agents/builtin/*.md (5 ファイル: bash / code-reviewer /
// explore / general-purpose / plan) を single source of truth とする。
// 外部 .md が見つからないエージェント名は task ツール側でエラー扱い。

// Shared loader instance (lazy-initialized)
let sharedLoader: AgentDefinitionLoader | null = null;

/** テキストに7行以上のコードブロックが含まれているか検出する */
function hasLargeCodeBlock(text: string): boolean {
  const matches = text.match(/```[\s\S]*?```/g);
  if (!matches) return false;
  return matches.some((block) => block.split("\n").length >= 7);
}

/** モデルがfile_writeをJSONコードブロックで「説明」した場合に抽出する */
function extractFakeFileWriteCalls(text: string): Array<{ file_path: string; content: string }> {
  const results: Array<{ file_path: string; content: string }> = [];
  const jsonBlockRegex = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let match;
  while ((match = jsonBlockRegex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      if (typeof obj.file_path === "string" && typeof obj.content === "string") {
        results.push({ file_path: obj.file_path, content: obj.content });
      }
    } catch {
      /* JSON パース失敗は無視 */
    }
  }
  return results;
}

function getLoader(): AgentDefinitionLoader {
  if (!sharedLoader) {
    sharedLoader = new AgentDefinitionLoader();
    sharedLoader.loadAll();
  }
  return sharedLoader;
}

/**
 * Resolve agent configuration by name from external definition file (`src/agents/builtin/*.md`).
 *
 * ID-014 (a) (2026-05-01): ハードコード fallback は撤去。 外部 .md が見つからない場合は
 * null を返し、 task ツール側で「不明な agent type」 エラーにする。
 */
function resolveAgentConfig(type: SubAgentType): Omit<SubAgentConfig, "description"> | null {
  const loader = getLoader();
  const externalDef = loader.get(type);

  if (externalDef) {
    logger.debug(`Using external agent definition for '${type}' from ${externalDef.source}`);
    return agentDefToConfig(externalDef);
  }

  logger.warn(
    `Agent definition '${type}' not found in src/agents/builtin/. ` + `Available: ${loader.listNames().join(", ")}`,
  );
  return null;
}

/**
 * Convert an AgentDefinition (from .md file) to a SubAgentConfig.
 */
function agentDefToConfig(def: AgentDefinition): Omit<SubAgentConfig, "description"> {
  return {
    type: def.name,
    systemPrompt: def.systemPrompt,
    allowedTools: def.allowedTools.length > 0 ? def.allowedTools : undefined,
    skills: def.skills.length > 0 ? def.skills : undefined,
  };
}

export interface SubAgentResult {
  agentId: string;
  type: SubAgentType;
  description: string;
  result: string;
  success: boolean;
}

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTaskSnapshot {
  agentId: string;
  type: SubAgentType;
  description: string;
  status: BackgroundTaskStatus;
  startedAt: string;
  completedAt?: string;
  /** 本文を露出せず、親から受理した追加指示の累計だけを可視化する。 */
  followUpCount: number;
}

interface BackgroundTaskRecord extends BackgroundTaskSnapshot {
  agent: SubAgent;
  promise: Promise<SubAgentResult>;
  result?: SubAgentResult;
}

const CANCELLED_RESULT = "Cancelled by task_cancel.";
const MAX_ITERATIONS_RESULT = "Maximum iterations reached without final response.";
const MAX_PENDING_FOLLOW_UPS = 20;
export const MAX_FOLLOW_UP_CHARS = 4_000;
const SKIPPED_FOR_FOLLOW_UP = "Skipped because a parent follow-up was received before execution.";

export type SendBackgroundResult =
  | { status: "queued"; followUpCount: number }
  | {
      status:
        | "not_found"
        | "already_finished"
        | "invalid_message"
        | "message_too_long"
        | "queue_full"
        | "turn_limit_reached";
    };

/**
 * サブエージェント 1 回分のモデル選択結果 (docs/model-orchestration.md §4.2)。
 * 解決に失敗しても起動は止めず、 main で走らせた事実を note で返す (silent な差し替えをしない)。
 */
export interface SubAgentModelChoice {
  provider: LLMProvider;
  model: string;
  /** main 以外のモデルで走る場合のみ設定される表示用ラベル (例: "review → azure-anthropic:claude-sonnet-4-6") */
  display?: string;
  /** 解決できなかった場合の注記。 task ツールが modelNote として結果に載せる */
  note?: string;
  /** /cost の slot 集計に使う。named slot でなければ main/subagent。 */
  usageSlot: UsageSlot;
}

/** スキルのcontext:forkで使用するカスタム設定のオーバーライド */
export interface SubAgentConfigOverrides {
  systemPrompt?: string;
  allowedTools?: string[];
  maxTurns?: number;
  /** この起動だけ追加でpreloadするskill名。agent定義のskillsと順序を保って結合する。 */
  skills?: string[];
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * agent定義とtask呼出で指定されたskillを有効registryから解決する。
 * 不存在/無効skillは専門agentの契約違反なので、黙って省略せずLLM起動前に失敗させる。
 */
export function resolvePreloadedSkills(
  requestedNames: readonly string[],
  registry: SkillRegistry | undefined,
  agentType: string,
): SkillDefinition[] {
  if (requestedNames.length === 0) return [];
  if (!registry) {
    throw new Error(`Sub-agent '${agentType}' requested preloaded skills, but SkillRegistry is not initialized.`);
  }

  const resolved: SkillDefinition[] = [];
  const seen = new Set<string>();
  for (const requested of requestedNames) {
    const name = requested.trim();
    if (!name) continue;
    const skill = registry.get(name);
    if (!skill) {
      throw new Error(`Preloaded skill '${name}' for sub-agent '${agentType}' was not found or is disabled.`);
    }
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    resolved.push(skill);
  }
  return resolved;
}

function buildPreloadedSkillBlock(skills: readonly SkillDefinition[], permissions: PermissionManager): string {
  if (skills.length === 0) return "";
  const sections = skills.map((skill) => {
    const skillDir = path.dirname(skill.filePath);
    permissions.addAllowedDir(skillDir);
    const content = skill.content.replace(/\$\{SKILL_DIR\}/g, skillDir);
    return `<preloaded-skill name="${escapeAttribute(skill.name)}" skill-dir="${escapeAttribute(skillDir)}">\n${content}\n</preloaded-skill>`;
  });
  return [
    "# Preloaded skills",
    "The following skill instructions are required for this sub-agent. Follow each applicable instruction.",
    ...sections,
  ].join("\n\n");
}

export class SubAgent {
  private agentId: string;
  private history: MessageHistory;
  private toolExecutor: ToolExecutor;
  private filteredRegistry: ToolRegistry;
  private config: SubAgentConfig;
  private aborted = false;
  private llmAbortController: AbortController | null = null;
  private pendingFollowUps: string[] = [];
  private iterationsStarted = 0;
  private iterationLimit = MAX_SUB_ITERATIONS;
  /** D1: 自分自身の ancestors (= 親の ancestors ∪ {"sub"})。 子エージェント生成時にさらに伝播 */
  private readonly selfAncestors: AncestorTypes;

  constructor(
    private provider: LLMProvider,
    private model: string,
    toolRegistry: ToolRegistry,
    permissions: PermissionManager,
    type: SubAgentType,
    description: string,
    overrides?: SubAgentConfigOverrides,
    /** D1: 親 (= 起動元エージェント) の ancestors。 メインから直接起動なら ROOT_ANCESTORS */
    parentAncestors: AncestorTypes = ROOT_ANCESTORS,
    private readonly usageSlot: UsageSlot = "subagent",
    skillRegistry?: SkillRegistry,
  ) {
    this.agentId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const resolved = resolveAgentConfig(type);
    if (!resolved) {
      throw new Error(`Unknown sub-agent type: '${type}'. No definition file or fallback found.`);
    }

    // context:fork は専用skill本文でsystem promptを置換するため、通常agent定義のpreloadは混ぜない。
    const configuredSkills = overrides?.systemPrompt === undefined ? (resolved.skills ?? []) : [];
    const preloadedSkills = resolvePreloadedSkills(
      [...configuredSkills, ...(overrides?.skills ?? [])],
      skillRegistry,
      String(type),
    );
    const preloadBlock = buildPreloadedSkillBlock(preloadedSkills, permissions);
    const baseSystemPrompt = overrides?.systemPrompt ?? resolved.systemPrompt;

    this.config = {
      ...resolved,
      description,
      systemPrompt: preloadBlock ? `${baseSystemPrompt}\n\n${preloadBlock}` : baseSystemPrompt,
      ...(overrides?.allowedTools !== undefined && { allowedTools: overrides.allowedTools }),
      skills: preloadedSkills.map((skill) => skill.name),
      maxTurns: normalizeSubAgentMaxTurns(overrides?.maxTurns ?? resolved.maxTurns),
    };
    this.iterationLimit = this.config.maxTurns ?? MAX_SUB_ITERATIONS;

    // D1: 自分は親 ancestors に "sub" を追加した位置にいる
    this.selfAncestors = extendAncestors(parentAncestors, "sub");
    // D1: ancestors に基づき task / second_llm_* を構造的に除外。
    //     allowedTools 指定があればそれと AND で交差させる (= ホワイトリスト ∩ 非除外)
    this.filteredRegistry = filterRegistryForAncestors(toolRegistry, this.selfAncestors, this.config.allowedTools);
    this.history = new MessageHistory(this.config.systemPrompt);
    // ToolExecutor にも自分の ancestors を渡し、 task / second_llm_* ツールが呼ばれた時に
    // さらに 1 段拡張した ancestors を子に伝播できるようにする
    this.toolExecutor = new ToolExecutor(this.filteredRegistry, permissions, undefined, this.selfAncestors);
  }

  /** 自分の ancestors を返す (D1: 主にテスト・デバッグ用) */
  getAncestors(): AncestorTypes {
    return this.selfAncestors;
  }

  async run(prompt: string): Promise<SubAgentResult> {
    this.history.addUserMessage(prompt);
    let finalResult = "";

    let codeBlockRetried = false;
    let continuationAttempts = 0;
    const MAX_CONTINUATION_ATTEMPTS = 3;
    // ID-012 (2026-04-30): 偽ユーザー発言の代わりに [自己点検] フォーマットを使う際、
    // 委任プロンプトを intent として渡すための保持
    const delegatePrompt = prompt;
    // D8: SubAgent もメイン / セカンドと同じハーネス介入レイヤを通す。
    // 壁ドンループ警告 / Read→Edit 契約 / 連続委任ガード / 旧エラーガイダンスが効く。
    const harnessState = new HarnessState();
    for (let iteration = 0; iteration < this.iterationLimit; iteration++) {
      this.iterationsStarted = iteration + 1;
      if (this.aborted) {
        finalResult = CANCELLED_RESULT;
        break;
      }
      this.flushFollowUps();
      try {
        const defs = this.filteredRegistry.getDefinitions();
        this.llmAbortController = new AbortController();
        const gen =
          defs.length > 0
            ? this.provider.chatWithTools({
                model: this.model,
                messages: this.history.getMessages(),
                tools: defs,
                stream: true,
                signal: this.llmAbortController.signal,
              })
            : this.provider.chat({
                model: this.model,
                messages: this.history.getMessages(),
                stream: true,
                signal: this.llmAbortController.signal,
              });

        let response: ChatResponse;
        try {
          response = await collectResponse(gen);
        } catch (error) {
          // task_send が進行中LLMを中断した場合は古い部分応答を採用せず、
          // mailboxを次turnへ注入する。通常のprovider errorは従来どおり失敗にする。
          if (!this.aborted && this.hasPendingFollowUps()) continue;
          throw error;
        } finally {
          this.llmAbortController = null;
        }
        if (this.aborted) {
          finalResult = CANCELLED_RESULT;
          break;
        }
        this.recordUsage(response.usage);

        // signalを無視するproviderもある。追加指示が生成中に届いていた場合は、
        // 返ってきた古いtool callを実行せず、pairingを保つskip結果だけを履歴へ置く。
        if (this.hasPendingFollowUps()) {
          this.history.addAssistantMessage(response.content, response.toolCalls);
          for (const toolCall of response.toolCalls) {
            this.history.addToolResult(toolCall.id, SKIPPED_FOR_FOLLOW_UP);
          }
          continue;
        }

        if (response.toolCalls.length > 0) {
          this.history.addAssistantMessage(response.content, response.toolCalls);

          for (const toolCall of response.toolCalls) {
            if (this.aborted) break;
            // 現在実行中のtoolは強制停止しない。戻った後は同じassistant turnに残る
            // 古いtool callへskip結果を補い、次turnで親の追加指示を適用する。
            if (this.hasPendingFollowUps()) {
              this.history.addToolResult(toolCall.id, SKIPPED_FOR_FOLLOW_UP);
              continue;
            }
            const result = await this.toolExecutor.execute(toolCall);
            const raw = result.success ? (result.output ?? "") : `Error: ${result.error ?? ""}\n${result.output ?? ""}`;
            // D8: ハーネス介入レイヤを通す (壁ドンループ警告 / Read→Edit 契約 等)
            const enriched = enrichToolResult(toolCall, result.success, raw, harnessState);
            this.history.addToolResult(toolCall.id, enriched);
          }
          if (this.aborted) {
            finalResult = CANCELLED_RESULT;
            break;
          }
          continue;
        }

        // Final response - no tool calls
        // 構造的に不完全（未閉じコードブロック/テーブル/単語途中終端）なら継続要求
        // メインエージェントと同じ補正: vLLM の finish_reason='stop' 誤報に対する I/O 境界補正
        if (continuationAttempts < MAX_CONTINUATION_ATTEMPTS) {
          const structural = isStructurallyIncomplete(response.content);
          if (structural.incomplete) {
            continuationAttempts++;
            logger.debug(`SubAgent: continuation requested (${structural.reason})`);
            this.history.addAssistantMessage(response.content);
            // ID-012: 偽ユーザー発言ではなく [自己点検] フォーマットでハーネス通知を明示
            this.history.addUserMessage(
              formatSelfCheck(
                continuationAttempts,
                MAX_CONTINUATION_ATTEMPTS,
                delegatePrompt,
                `応答が途中で切れています (${structural.reason})。 続きを出力してタスクを完成させてください。`,
                SUB_AGENT_ACTION_HINT,
              ),
            );
            continue;
          }
        }

        // コードブロックをテキストで返した場合のリプロンプト（file_write未使用検出）
        if (!codeBlockRetried && hasLargeCodeBlock(response.content)) {
          codeBlockRetried = true;
          this.history.addAssistantMessage(response.content);
          // ID-012: 偽ユーザー発言ではなく [自己点検] フォーマットでハーネス通知を明示
          this.history.addUserMessage(
            formatSelfCheck(
              1,
              1,
              delegatePrompt,
              "コードをテキストで返しましたが、 成果物として file_write ツールでファイル化してください。 コードをチャットに書くのではなく、 必ず file_write ツールを使用してください。",
              SUB_AGENT_ACTION_HINT,
            ),
          );
          continue;
        }

        // リプロンプト後もJSONコードブロックで返した場合は直接実行
        if (codeBlockRetried) {
          const fakeWrites = extractFakeFileWriteCalls(response.content);
          if (fakeWrites.length > 0) {
            this.history.addAssistantMessage(response.content);
            for (const fw of fakeWrites) {
              const syntheticCall = {
                id: `synthetic_fw_${Date.now()}`,
                type: "function" as const,
                function: { name: "file_write", arguments: JSON.stringify(fw) },
              };
              const result = await this.toolExecutor.execute(syntheticCall);
              const raw = result.success
                ? (result.output ?? "")
                : `Error: ${result.error ?? ""}\n${result.output ?? ""}`;
              const enriched = enrichToolResult(syntheticCall, result.success, raw, harnessState);
              this.history.addToolResult(syntheticCall.id, enriched);
            }
            // ID-012: 偽ユーザー発言ではなく [自己点検] フォーマットでハーネス通知を明示
            this.history.addUserMessage(
              formatSelfCheck(
                1,
                1,
                delegatePrompt,
                "ファイル作成が完了しました。 作業の最終結果を整理して回答してください。",
                SUB_AGENT_ACTION_HINT,
              ),
            );
            continue;
          }
        }

        this.history.addAssistantMessage(response.content);
        finalResult = response.content;
        break;
      } catch (e) {
        finalResult = this.aborted ? CANCELLED_RESULT : `Error: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }

    if (!finalResult) {
      finalResult = MAX_ITERATIONS_RESULT;
    }

    return {
      agentId: this.agentId,
      type: this.config.type,
      description: this.config.description,
      result: finalResult,
      success:
        !finalResult.startsWith("Error:") && finalResult !== CANCELLED_RESULT && finalResult !== MAX_ITERATIONS_RESULT,
    };
  }

  /**
   * 親orchestratorからの追加指示をFIFO mailboxへ積む。
   * LLM生成中ならsignalで早期に切り上げるが、進行中toolは強制停止しない。
   */
  queueFollowUp(message: string): "queued" | "queue_full" | "turn_limit_reached" {
    if (this.pendingFollowUps.length >= MAX_PENDING_FOLLOW_UPS) return "queue_full";
    if (this.iterationsStarted >= this.iterationLimit) {
      if (this.iterationLimit >= MAX_SUB_ITERATIONS) return "turn_limit_reached";
      this.iterationLimit++;
    }
    this.pendingFollowUps.push(message);
    this.llmAbortController?.abort();
    return "queued";
  }

  private hasPendingFollowUps(): boolean {
    return this.pendingFollowUps.length > 0;
  }

  private flushFollowUps(): void {
    const messages = this.pendingFollowUps.splice(0);
    for (const message of messages) {
      // providerにはuser/assistant/tool/systemしかないためuser roleを使うが、
      // 実ユーザー発言ではなく親agent由来だと明示してprovenanceを保つ。
      this.history.addUserMessage(`[parent-follow-up]\n${message}`);
    }
  }

  /** background taskの協調中断。進行中LLM接続を切り、次のtool/iterationを開始させない。 */
  abort(): boolean {
    if (this.aborted) return false;
    this.aborted = true;
    this.llmAbortController?.abort();
    return true;
  }

  getAgentId(): string {
    return this.agentId;
  }

  /** collectResponse が保持した done usage を、メイン/second と同じ台帳へ記録する。 */
  private recordUsage(usage: TokenUsage | undefined): void {
    if (!usage) return;
    const promptTokens = usage.promptTokens ?? 0;
    const outputTokens = usage.completionTokens ?? 0;
    const cacheRead = usage.cachedTokens ?? 0;
    const cacheCreation = usage.cacheCreationTokens ?? 0;
    // 0 件でもフィールドが存在すれば Anthropic semantics。値だけで判定すると、
    // cache hit のみの応答を OpenAI semantics と誤認して入力トークンを過少計上する。
    const anthropicSemantics = usage.cacheCreationTokens !== undefined;
    const estimatedCostUsd = anthropicSemantics
      ? globalCostCalculator.calculateForModelWithCacheBreakdown(
          this.model,
          promptTokens,
          outputTokens,
          cacheRead,
          cacheCreation,
        )
      : globalCostCalculator.calculateForModelWithCache(this.model, promptTokens, outputTokens, cacheRead);

    globalTokenTracker.record({
      timestamp: new Date().toISOString(),
      provider: this.provider.providerType,
      model: this.model,
      slot: this.usageSlot,
      inputTokens: anthropicSemantics ? promptTokens + cacheRead + cacheCreation : promptTokens,
      outputTokens,
      cachedTokens: cacheRead,
      estimatedCostUsd,
    });
  }
}

export class SubAgentManager {
  private backgroundTasks = new Map<string, BackgroundTaskRecord>();

  constructor(
    private provider: LLMProvider,
    private model: string,
    private toolRegistry: ToolRegistry,
    private permissions: PermissionManager,
    private skillRegistry?: SkillRegistry,
  ) {}

  /**
   * サブエージェント起動に使うProvider/Modelを差し替える。
   * /model url, /model provider 等でメインLLMの接続先が変わったときに呼ぶ。
   */
  setProvider(provider: LLMProvider, model: string): void {
    this.provider = provider;
    this.model = model;
  }

  /**
   * このサブエージェントを走らせる provider/model を決める (docs/model-orchestration.md §4.2)。
   *
   * 優先順位: 呼出時の明示指定 > エージェント定義の modelRef > main (自分の provider)。
   * 解決先が main slot と同じ entry なら自分の provider をそのまま使う
   * (/model url 等でランタイム差し替えされた接続を尊重するため)。
   *
   * ここではログを出さない。 解決失敗は note で返し、 起動側 (launch*) が 1 回だけ警告する。
   */
  resolveModelFor(type: SubAgentType, explicitRef?: string): SubAgentModelChoice {
    const fallback: SubAgentModelChoice = { provider: this.provider, model: this.model, usageSlot: "main" };
    const ref = explicitRef?.trim() || getLoader().get(type)?.modelRef;
    if (!ref) return fallback;

    const resolved = resolveModelRef(ref);
    if (!resolved) {
      return {
        ...fallback,
        note:
          `指定された model '${ref}' は未割当のため main で実行しました。 ` +
          `/models slot ${ref} <モデル> で割り当てられます。`,
      };
    }

    // main と同じ entry に解決された場合は従来経路 (自分の provider) を使う
    const mainId = getSlot("main");
    if (mainId && resolved.entryId === mainId) return fallback;

    return {
      provider: resolved.provider,
      model: resolved.model,
      display: `${ref} → ${resolved.label}`,
      usageSlot: resolved.slot ?? "subagent",
    };
  }

  /** launch* 共通: モデルを解決し、 解決失敗なら 1 回だけ警告する。 */
  private pickModel(type: SubAgentType, modelRef?: string): SubAgentModelChoice {
    const choice = this.resolveModelFor(type, modelRef);
    if (choice.note) logger.warn(choice.note);
    return choice;
  }

  launchBackground(
    type: SubAgentType,
    description: string,
    prompt: string,
    parentAncestors: AncestorTypes = ROOT_ANCESTORS,
    modelRef?: string,
    maxTurns?: number,
    skills?: string[],
  ): string {
    const picked = this.pickModel(type, modelRef);
    const agent = new SubAgent(
      picked.provider,
      picked.model,
      this.toolRegistry,
      this.permissions,
      type,
      description,
      { maxTurns: normalizeSubAgentMaxTurns(maxTurns), skills },
      parentAncestors,
      picked.usageSlot,
      this.skillRegistry,
    );
    const id = agent.getAgentId();
    const startedAt = new Date().toISOString();
    const promise = agent
      .run(prompt)
      .then((result) => {
        const current = this.backgroundTasks.get(id);
        if (!current || current.status === "cancelled") return current?.result ?? result;
        current.result = result;
        current.status = result.success ? "completed" : "failed";
        current.completedAt = new Date().toISOString();
        return result;
      })
      .catch((error) => {
        const current = this.backgroundTasks.get(id);
        const result: SubAgentResult = {
          agentId: id,
          type,
          description,
          result: `Error: ${error instanceof Error ? error.message : String(error)}`,
          success: false,
        };
        if (current?.status === "cancelled") return current.result ?? result;
        if (current) {
          current.result = result;
          current.status = "failed";
          current.completedAt = new Date().toISOString();
        }
        return result;
      });
    this.backgroundTasks.set(id, {
      agentId: id,
      type,
      description,
      status: "running",
      startedAt,
      followUpCount: 0,
      agent,
      promise,
    });
    return id;
  }

  async launchForeground(
    type: SubAgentType,
    description: string,
    prompt: string,
    parentAncestors: AncestorTypes = ROOT_ANCESTORS,
    modelRef?: string,
    maxTurns?: number,
    skills?: string[],
  ): Promise<SubAgentResult> {
    const picked = this.pickModel(type, modelRef);
    const agent = new SubAgent(
      picked.provider,
      picked.model,
      this.toolRegistry,
      this.permissions,
      type,
      description,
      { maxTurns: normalizeSubAgentMaxTurns(maxTurns), skills },
      parentAncestors,
      picked.usageSlot,
      this.skillRegistry,
    );
    return agent.run(prompt);
  }

  async launchParallel(
    tasks: Array<{ type: SubAgentType; description: string; prompt: string; modelRef?: string; skills?: string[] }>,
    parentAncestors: AncestorTypes = ROOT_ANCESTORS,
  ): Promise<SubAgentResult[]> {
    const promises = tasks.map((task) => {
      const picked = this.pickModel(task.type, task.modelRef);
      const agent = new SubAgent(
        picked.provider,
        picked.model,
        this.toolRegistry,
        this.permissions,
        task.type,
        task.description,
        task.skills ? { skills: task.skills } : undefined,
        parentAncestors,
        picked.usageSlot,
        this.skillRegistry,
      );
      return agent.run(task.prompt);
    });
    return Promise.allSettled(promises).then((results) =>
      results.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : {
              agentId: `failed-${i}`,
              type: tasks[i].type,
              description: tasks[i].description,
              result: `Error: ${r.reason}`,
              success: false,
            },
      ),
    );
  }

  /**
   * スキルのcontext:fork用: スキル内容をsystemPromptとしてSubAgentを起動する。
   * スキルの指示を独立したコンテキストで実行し、メインコンテキストを汚染しない。
   */
  async launchSkillFork(
    skillName: string,
    skillSystemPrompt: string,
    allowedTools: string[] | undefined,
    prompt: string,
    parentAncestors: AncestorTypes = ROOT_ANCESTORS,
    modelRef?: string,
  ): Promise<SubAgentResult> {
    const picked = this.pickModel("general-purpose", modelRef);
    const agent = new SubAgent(
      picked.provider,
      picked.model,
      this.toolRegistry,
      this.permissions,
      "general-purpose",
      `skill:${skillName}`,
      { systemPrompt: skillSystemPrompt, allowedTools },
      parentAncestors,
      picked.usageSlot,
      this.skillRegistry,
    );
    return agent.run(prompt);
  }

  async getResult(agentId: string): Promise<SubAgentResult | null> {
    const task = this.backgroundTasks.get(agentId);
    if (!task) return null;
    const result = task.result ?? (await task.promise);
    this.backgroundTasks.delete(agentId);
    return result;
  }

  isRunning(agentId: string): boolean {
    return this.backgroundTasks.get(agentId)?.status === "running";
  }

  listBackgroundTasks(): BackgroundTaskSnapshot[] {
    return [...this.backgroundTasks.values()].map(
      ({ agentId, type, description, status, startedAt, completedAt, followUpCount }) => ({
        agentId,
        type,
        description,
        status,
        startedAt,
        ...(completedAt ? { completedAt } : {}),
        followUpCount,
      }),
    );
  }

  sendBackground(agentId: string, message: string): SendBackgroundResult {
    const task = this.backgroundTasks.get(agentId);
    if (!task) return { status: "not_found" };
    if (task.status !== "running") return { status: "already_finished" };

    const normalized = message.trim();
    if (!normalized) return { status: "invalid_message" };
    if (normalized.length > MAX_FOLLOW_UP_CHARS) return { status: "message_too_long" };

    const status = task.agent.queueFollowUp(normalized);
    if (status !== "queued") return { status };
    task.followUpCount++;
    return { status: "queued", followUpCount: task.followUpCount };
  }

  cancelBackground(agentId: string): "cancelled" | "not_found" | "already_finished" {
    const task = this.backgroundTasks.get(agentId);
    if (!task) return "not_found";
    if (task.status !== "running") return "already_finished";

    task.status = "cancelled";
    task.completedAt = new Date().toISOString();
    task.result = {
      agentId,
      type: task.type,
      description: task.description,
      result: CANCELLED_RESULT,
      success: false,
    };
    task.agent.abort();
    return "cancelled";
  }
}
