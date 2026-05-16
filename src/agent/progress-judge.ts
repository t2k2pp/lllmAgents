/**
 * Q→A Progress Judge — sub-agent 様の isolated 判定器
 *
 * docs/strategic-todo-design.md 議論 (2026-05-16) で固まった設計:
 * - response_complete 宣言時に、 本当に user の Q に答えたか / 答えるための meaningful な
 *   action を取ったかを **同 model の sub-agent パターン** (curated context、 isolated) で判定
 * - tool 種別 (MCP / skill / file_write 等) には依存しない base harness の責務
 * - レジスター standard 以上で発火
 * - 「完了したと言うが実体がない」 のような shallow completion を弾く gate
 *
 * 既存 Evaluator との違い:
 * - 入力が file path ではなく「元 Q + 履歴要約 + 最新応答」
 * - sub-agent (curated context) で呼び、 メイン chat history を汚さない
 * - tool 非依存、 すべての response_complete に発火可能
 */

import type { LLMProvider, ToolCall } from "../providers/base-provider.js";
import { collectResponse } from "../providers/base-provider.js";
import * as logger from "../utils/logger.js";

export type ProgressVerdict = "answered" | "took_step" | "stalled";

export interface JudgeProgressInput {
  /** user の元発話 (北極星) */
  originalUserMessage: string;
  /** 直近のツール呼出 + 結果の軽量要約 (tool 名 + 短縮 args + 結果サイズ等) */
  recentSummary: string;
  /** 最新の assistant 応答 (text + tool_calls)。 response_complete も toolCalls に含まれる */
  latestResponse: { text: string; toolCalls: ToolCall[] };
  /** 判定に使う provider (main と同じで良い)。 sub-agent 的に isolated context で呼ぶ */
  provider: LLMProvider;
  /** 判定に使う model */
  model: string;
}

export interface JudgeProgressResult {
  verdict: ProgressVerdict;
  reason: string;
}

const JUDGE_TEMPERATURE = 0;
const JUDGE_MAX_TOKENS = 200;

function buildJudgePrompt(input: JudgeProgressInput): string {
  const latestText = input.latestResponse.text.trim() || "(本文なし)";
  const latestToolCalls = input.latestResponse.toolCalls.length > 0
    ? input.latestResponse.toolCalls.map((tc) => {
        const args = (tc.function.arguments ?? "").slice(0, 120);
        return `- ${tc.function.name}(${args})`;
      }).join("\n")
    : "(ツール呼出なし)";

  return `あなたは Q→A 進捗判定 judge です。
別の AI agent が応答 (もしくは完了宣言) を返したので、 本当に user の Q に答えたか、
答えるための meaningful な action を取ったかを判定してください。

# 元の Q (user の依頼)
${input.originalUserMessage}

# agent の作業履歴 (直近、 要約)
${input.recentSummary || "(履歴なし)"}

# 最終応答
text:
${latestText}

tool_calls:
${latestToolCalls}

# 判定基準
- "answered": Q に直接答えた / 求められた成果物が完成している
- "took_step": Q への中間 action (情報収集、 段階的進捗、 計画 commit 等) を取った
- "stalled": Q への進捗が読み取れない (= 雑談、 言い訳、 表面的「完了」 宣言のみ、 自己満足)

# 留意
- 「I'll do X」 「実装します」 等の promise だけは stalled
- ツールを呼んでいても、 元 Q と無関係なら stalled
- 部分的でも実態のある進捗があれば took_step (厳しすぎない判定)

# 出力 (JSON 1 行のみ、 他のテキスト不要)
{"verdict": "answered" | "took_step" | "stalled", "reason": "<簡潔な根拠 1-2 文>"}`;
}

function parseJudgeResponse(raw: string): JudgeProgressResult {
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const verdict = parsed.verdict;
      const reason = typeof parsed.reason === "string" ? parsed.reason : "(reason 不明)";
      if (verdict === "answered" || verdict === "took_step" || verdict === "stalled") {
        return { verdict, reason };
      }
    } catch { /* fall through */ }
  }
  // パース失敗時のフォールバック: 緩め判定 (stalled に倒さない)
  return { verdict: "took_step", reason: "judge 出力 parse 失敗、 緩めで took_step に倒す" };
}

/**
 * 直近のツール履歴 + 結果から軽量要約を作る。
 * 案 (ii): ツール名 + 引数の短縮 + 結果サイズ。 元 chat 履歴をそのまま渡すより軽い。
 */
export function buildRecentSummary(messages: Array<{ role: string; content: unknown; tool_calls?: ToolCall[] }>, maxTurns: number = 5): string {
  // 直近 N ターン = 約 N*3 メッセージ (user / assistant / tool 等)
  const recent = messages.slice(-(maxTurns * 4));
  const lines: string[] = [];
  for (const m of recent) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        const args = String(tc.function.arguments ?? "").replace(/\s+/g, " ").slice(0, 100);
        lines.push(`call: ${tc.function.name}(${args}${args.length >= 100 ? "..." : ""})`);
      }
    } else if (m.role === "tool") {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const summary = content.replace(/\s+/g, " ").slice(0, 100);
      lines.push(`  → ${summary}${content.length >= 100 ? "..." : ""}`);
    } else if (m.role === "user") {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      // [ハーネス通知] 等のシステム inject は要約に含めない (ノイズ)
      if (content.startsWith("[ハーネス") || content.startsWith("[自己点検")) continue;
      const summary = content.replace(/\s+/g, " ").slice(0, 100);
      if (summary.length > 0) lines.push(`user: ${summary}${content.length >= 100 ? "..." : ""}`);
    }
  }
  return lines.join("\n");
}

export async function judgeProgress(input: JudgeProgressInput): Promise<JudgeProgressResult> {
  const prompt = buildJudgePrompt(input);

  try {
    const gen = input.provider.chat({
      model: input.model,
      messages: [{ role: "user", content: prompt }],
      temperature: JUDGE_TEMPERATURE,
      maxTokens: JUDGE_MAX_TOKENS,
      stream: true,
    });
    const response = await collectResponse(gen);
    const result = parseJudgeResponse(response.content);
    logger.debug(`[progress-judge] verdict=${result.verdict} reason=${result.reason.slice(0, 80)}`);
    return result;
  } catch (e) {
    logger.warn(`[progress-judge] failed, falling back to took_step: ${String(e).slice(0, 100)}`);
    return { verdict: "took_step", reason: `judge 呼出失敗、 緩めで took_step に倒す (${String(e).slice(0, 60)})` };
  }
}
