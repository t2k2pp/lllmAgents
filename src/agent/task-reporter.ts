/**
 * タスク完了報告のフォーマッタ (A-6: docs/task-report-notification-design.md)
 *
 * task_complete イベントから、 チャネル応答のフッターと proactive 通知
 * (Discord/Slack webhook) の本文を組み立てる。
 *
 * 原則 (docs/autonomy-improvement-proposal.md §6):
 * - 捏造しない: outcome を正直に表示する (中断/エラー/反復上限を completed と偽らない)
 * - silent 欠損禁止: 0 件・$0 はそのまま見せる (隠さない)
 */

import type { AgentEventMap, TaskOutcome } from "./agent-events.js";

type TaskCompleteEvent = AgentEventMap["task_complete"];

const OUTCOME_LABELS: Record<TaskOutcome, { icon: string; label: string }> = {
  completed: { icon: "✅", label: "完了" },
  aborted: { icon: "🛑", label: "中断" },
  error: { icon: "❌", label: "エラー" },
  max_iterations: { icon: "⚠️", label: "反復上限で打ち切り" },
  incomplete: { icon: "⚠️", label: "未完了" },
};

export function formatOutcome(outcome: TaskOutcome): string {
  const o = OUTCOME_LABELS[outcome];
  return `${o.icon} ${o.label}`;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}秒`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}分${sec}秒` : `${min}分`;
  const hour = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hour}時間${remMin}分` : `${hour}時間`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** 統計の 1 行サマリ (例: "⏱ 2分34秒 · 🔧 12 tools · 📝 3 files · 💰 $0.0123") */
export function formatStatsLine(e: TaskCompleteEvent): string {
  const parts = [`⏱ ${formatDuration(e.durationMs)}`, `🔧 ${e.toolsExecuted} tools`];
  if (e.filesChanged.length > 0) {
    parts.push(`📝 ${e.filesChanged.length} files`);
  }
  if (e.tokensIn > 0 || e.tokensOut > 0) {
    const cost = e.costUsd > 0 ? ` ($${e.costUsd.toFixed(4)})` : "";
    parts.push(`🪙 in ${formatTokens(e.tokensIn)}/out ${formatTokens(e.tokensOut)}${cost}`);
  }
  return parts.join(" · ");
}

/**
 * チャネル応答 (Slack/Discord) に付けるコンパクトなフッター。
 * ツールを使っていない会話的応答ではノイズになるため null を返す。
 */
export function formatReportFooter(e: TaskCompleteEvent): string | null {
  if (e.toolsExecuted === 0 && e.outcome === "completed") return null;
  const lines: string[] = ["—"];
  if (e.outcome !== "completed") {
    lines.push(formatOutcome(e.outcome));
  }
  lines.push(formatStatsLine(e));
  if (e.filesChanged.length > 0 && e.filesChanged.length <= 5) {
    for (const f of e.filesChanged) lines.push(`  - ${f}`);
  }
  return lines.join("\n");
}

/**
 * proactive 通知 (webhook) の本文。 最終応答の要約 + 構造化サマリ。
 * 通知先は閲覧専用のため、 ファイル内容やコマンド出力は載せない (パス + 統計のみ)。
 */
export function formatTaskReport(e: TaskCompleteEvent, maxResponseChars = 800): string {
  const lines: string[] = [];
  lines.push(`${formatOutcome(e.outcome)} (${formatDuration(e.durationMs)})`);

  const response = e.finalResponse.trim();
  if (response) {
    lines.push("");
    lines.push(response.length > maxResponseChars
      ? response.slice(0, maxResponseChars) + "\n…(以下省略)"
      : response);
  } else if (e.outcome !== "completed") {
    lines.push("");
    lines.push("（最終応答はありません。ターミナル側のログを確認してください）");
  }

  lines.push("");
  lines.push(formatStatsLine(e));
  if (e.filesChanged.length > 0) {
    const shown = e.filesChanged.slice(0, 10);
    for (const f of shown) lines.push(`- ${f}`);
    if (e.filesChanged.length > shown.length) {
      lines.push(`- …他 ${e.filesChanged.length - shown.length} ファイル`);
    }
  }
  return lines.join("\n");
}
