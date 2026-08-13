/**
 * 指示 → 検証可能ゴールへの正規化 (B-1: docs/goal-promotion-design.md)
 *
 * 複雑なタスク依頼を検出したら Goal Seek mode への昇格を「提案」し、
 * ユーザー承認 (CLI: confirm / チャネル: ボタン) をもって goal slot を設定する。
 * 自動切替はしない (goal-seek-mode-design.md §2.2 「切替は user 明示のみ」 を維持)。
 */

import chalk from "chalk";
// プロンプト表示中はライブ領域を排他所有する (docs/tui-alternate-screen.md §4.3)
import { confirm } from "../cli/prompt-gate.js";
import type { LLMProvider } from "../providers/base-provider.js";
import { collectResponse } from "../providers/base-provider.js";
import type { GoalDefinition } from "./goal-slot.js";
import type { AgentMode } from "./agent-loop.js";
import type { RequestSource } from "../security/permission-manager.js";
import { getInteractionBridge } from "./interaction-bridge-registry.js";
import { classifyTaskComplexity } from "./task-complexity.js";
import { IntentClassifier } from "./intent-classifier.js";
import { loadConfig } from "../config/config-manager.js";
import * as logger from "../utils/logger.js";

/** 提案先のエージェント (AgentLoop の必要最小インターフェース) */
export interface GoalPromotionAgent {
  getMode(): AgentMode;
  getMetrics(): { register: string };
  getProvider(): LLMProvider;
  getModel(): string;
  enterGoalSeek(goal: GoalDefinition): void;
}

/** 拒否 cooldown: 10 分。 同プロセス 2 回拒否で以後提案しない (設計書 §2) */
const DECLINE_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_DECLINES = 2;

let _declineCount = 0;
let _suppressUntil = 0;

/** テスト用: cooldown 状態をリセット */
export function resetGoalPromotionState(): void {
  _declineCount = 0;
  _suppressUntil = 0;
}

/**
 * goal 文から検証可能な acceptance criteria を抽出する。
 * `/goal-seek` コマンドと B-1 自動提案の共通ロジック (設計書 §3)。
 * 抽出できなければ空配列 (呼び出し元がフォールバックする)。
 */
export async function extractAcceptanceCriteria(
  provider: LLMProvider,
  model: string,
  goalText: string,
): Promise<string[]> {
  const extractPrompt =
    `ユーザーから以下の goal が提供されました:\n\n` +
    `${goalText}\n\n` +
    `この goal を達成するための **検証可能な acceptance criteria** を 3-5 個、 JSON 配列形式で抽出してください。\n` +
    `criteria は「動作する」「ファイルが存在する」「テストがパスする」 等、 客観的に判定可能な観点で記述すること。\n` +
    `各 criterion は 1 文 (50 文字程度) で簡潔に。\n\n` +
    `出力形式 (JSON のみ、 他のテキストは不要):\n` +
    `{"criteria": ["criterion 1", "criterion 2", "criterion 3"]}`;

  try {
    const gen = provider.chat({
      model,
      messages: [{ role: "user", content: extractPrompt }],
      temperature: 0.1,
      maxTokens: 800,
      stream: true,
    });
    const response = await collectResponse(gen);
    const jsonMatch = response.content.match(/\{[\s\S]*?"criteria"[\s\S]*?\]\s*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.criteria)) {
        return parsed.criteria.filter((c: unknown): c is string => typeof c === "string");
      }
    }
  } catch (e) {
    logger.debug(`acceptance criteria extraction failed: ${e}`);
  }
  return [];
}

/**
 * 複雑なタスク依頼なら Goal Seek への昇格を提案する。
 * 承認されたら enterGoalSeek を呼び true を返す (呼び出し元はそのまま run すればよい)。
 * 提案しない / 拒否 / 失敗は false (通常実行へ。 提案はベストエフォートで本処理を妨げない)。
 */
export async function maybePromoteToGoal(opts: {
  input: string;
  source: RequestSource;
  agent: GoalPromotionAgent;
  /** 省略時は config.goalSeek.autoPropose (デフォルト true) */
  enabled?: boolean;
}): Promise<boolean> {
  const { input, source, agent } = opts;
  try {
    const enabled = opts.enabled ?? loadConfig().goalSeek?.autoPropose ?? true;
    if (!enabled) return false;
    if (agent.getMode() === "goal-seek") return false;
    if (Date.now() < _suppressUntil || _declineCount >= MAX_DECLINES) return false;

    // 発動条件: complex かつ heuristic で明白なタスク (曖昧なら提案しない = 保守的)
    if (classifyTaskComplexity(input) !== "complex") return false;
    const classifier = new IntentClassifier(agent.getProvider(), agent.getModel());
    if (!classifier.isObviousTask(input)) return false;

    // UI 前提チェック: CLI は TTY のみ (非 TTY パイプモードでは提案しない)、
    // チャネルは askUser ブリッジ登録時のみ
    const bridge = source === "cli" ? null : getInteractionBridge(source);
    if (source === "cli") {
      if (!process.stdin.isTTY) return false;
    } else if (!bridge?.askUser) {
      return false;
    }

    // criteria 抽出 (LLM)。 失敗したら黙って通常実行
    const criteria = await extractAcceptanceCriteria(agent.getProvider(), agent.getModel(), input);
    if (criteria.length === 0) return false;

    // 承認
    const approved =
      source === "cli" ? await askCliApproval(criteria) : await askChannelApproval(bridge!, criteria, source);

    if (!approved) {
      _declineCount++;
      _suppressUntil = Date.now() + DECLINE_COOLDOWN_MS;
      logger.debug(`[goal-promotion] declined (${_declineCount}/${MAX_DECLINES})`);
      return false;
    }

    const goal: GoalDefinition = {
      statement: input,
      acceptance_criteria: criteria,
      created_at: Date.now(),
      register_at_creation: agent.getMetrics().register,
    };
    agent.enterGoalSeek(goal);
    if (source === "cli") {
      console.log(chalk.green(`  ✓ Goal Seek mode 開始 (criteria ${criteria.length} 項目)。 中断: /exit-goal-seek`));
    }
    return true;
  } catch (e) {
    // 提案はベストエフォート: 失敗しても通常実行に進む
    logger.debug(`[goal-promotion] proposal failed: ${e}`);
    return false;
  }
}

async function askCliApproval(criteria: string[]): Promise<boolean> {
  console.log(chalk.cyan("\n  複雑なタスクのようです。 検証可能なゴールとして進めることを提案します:"));
  criteria.forEach((c, i) => console.log(chalk.dim(`    ${i + 1}. ${c}`)));
  try {
    return await confirm({
      message: "  この acceptance criteria で Goal Seek mode を開始しますか? (No = 通常実行)",
      default: true,
    });
  } catch {
    return false; // Ctrl+C 等は通常実行へ
  }
}

async function askChannelApproval(
  bridge: NonNullable<ReturnType<typeof getInteractionBridge>>,
  criteria: string[],
  source: RequestSource,
): Promise<boolean> {
  if (!bridge.askUser) return false;
  const GOAL_SEEK = "Goal Seek で実行";
  const NORMAL = "通常実行";
  const list = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const res = await bridge.askUser({
    question:
      `複雑なタスクのようです。以下の acceptance criteria を立てて、全項目を満たすまで自律実行する ` +
      `Goal Seek mode で進めますか？\n${list}`,
    choices: [GOAL_SEEK, NORMAL],
    source,
  });
  return res.answer === GOAL_SEEK;
}
