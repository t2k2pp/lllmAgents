/**
 * 整理イベントの段階 3 を、 タスクの引き継ぎ文書の抜粋への置き換えで行う (docs/task-handoff-design.md §9。 第 2 段)。
 *
 * 使っている文書があるとき、 段階 0〜2 の後の写しのうち「先頭のポインタの後ろから保護部分の手前まで」 を、
 * 文書から毎回抜き出し直した抜粋 1 件 (user。 先頭 <task-handoff-excerpt) に置き換える。 範囲の中の
 * - 既存の要約 (<summary-of-earlier-turns>) と前回の抜粋: 落とす (抜粋は文書から作り直す。 要約の要約・抜粋の重ねをしない)
 * - 忘却の記録 (system の [忘却の記録]): 落とし、 行は抜粋の末尾の「忘却の記録」 に直近 EXCERPT_FORGET_LINES_KEPT 行だけ写す
 * - 利用者の発言: 文書の「依頼の原文」 に同じ文がそのまま入っているもの (文字だけのもの) は落とす。 入っていないもの・画像付きは残す
 * - ハーネスの促し (揮発の user)・モデルの発言・ツールの組: 落とす (判断の節は整理の前の更新で文書に入っている)。
 *   ただし利用者の答え・承認を持つツールの組 (EXCERPT_KEPT_TOOL_NAMES) は残す
 * - ポインタ ([タスクの記録]): 残す
 *
 * ここは写しに対する純粋な関数だけ。 文書の更新 (LLM)・差し替えは reduction-event.ts と AgentLoop。
 */
import type { Message } from "../providers/base-provider.js";
import { isReductionSummaryMessage, protectedTailStart } from "./reduction-summary.js";
import { contentToText, TOMBSTONE_MARKER } from "./reduction-stages.js";
import {
  type ExcerptForgetDigest,
  isTaskHandoffExcerptMessage,
  isTaskPointerMessage,
  messageText,
  renderTaskHandoffExcerpt,
  TASK_EXCERPT_CLOSE,
  TASK_EXCERPT_FORGET_HEADING,
  type TaskHandoffDoc,
} from "./task-handoff.js";

/** 抜粋に写す忘却の記録の行の上限 (古いものから省き、 省いた数だけ残す。 §9.5) */
export const EXCERPT_FORGET_LINES_KEPT = 12;

/** 抜粋に置き換えずに残すツールの組 (利用者の答え・プランの承認。 文書の節に機械的に写らないため) */
export const EXCERPT_KEPT_TOOL_NAMES: ReadonlySet<string> = new Set(["ask_user", "enter_plan_mode", "exit_plan_mode"]);

/** 忘却の記録の締めの行 (reduction-event.ts の buildReductionTombstoneText と同じ文) */
const TOMBSTONE_FOOTER = "必要になった情報は再度ツールで取得してください。";
const OMITTED_LINE = /^- \(これより前の (\d+) 行は省略\)$/;

/** 置き換える範囲の中身の内訳 (記録 reduction_event の taskExcerpt に出す) */
export interface ExcerptCounts {
  /** 落とした要約 */
  summaries: number;
  /** 落とした前回の抜粋 */
  excerpts: number;
  /** 落とした忘却の記録 (system) */
  forgetNotes: number;
  /** 落とした利用者の発言 (文書の依頼の原文にそのまま入っているもの) */
  userMessages: number;
  /** 落としたそのほか (揮発の促し・モデルの発言・ツールの組の各メッセージ) */
  otherMessages: number;
  /** 範囲の中で残したメッセージ (文書に無い利用者の発言・ポインタ・残すツールの組・そのほかの system) */
  keptMessages: number;
}

export interface ExcerptPlan {
  /** 写しでの範囲 [start, end) */
  start: number;
  end: number;
  /** 範囲の各メッセージを残すか (長さ end − start) */
  keep: boolean[];
  counts: ExcerptCounts;
  /** 抜粋に添える忘却の記録 (前回の抜粋・範囲の忘却の記録・今回の行を合わせて上限で切ったもの) */
  forget: ExcerptForgetDigest;
}

function hasToolCalls(m: Message | undefined): boolean {
  return !!m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

function isTextOnly(m: Message): boolean {
  return typeof m.content === "string" || m.content.every((p) => p.type === "text");
}

function isTombstone(m: Message): boolean {
  return m.role === "system" && contentToText(m.content).startsWith(TOMBSTONE_MARKER);
}

/** 文書から作り直せる派生物 (要約・前の抜粋・忘却の記録) */
function isDerived(m: Message): boolean {
  return isReductionSummaryMessage(m) || isTaskHandoffExcerptMessage(m) || isTombstone(m);
}

/** 忘却の記録 (system) から行を取る (見出しと締めの行は除く) */
function tombstoneLines(m: Message): string[] {
  return contentToText(m.content)
    .split("\n")
    .filter((l) => l.trim().length > 0 && !l.startsWith(TOMBSTONE_MARKER) && l.trim() !== TOMBSTONE_FOOTER);
}

/** 前回の抜粋の忘却の記録の節から、 行と省いた数を読み戻す */
function excerptForget(m: Message): ExcerptForgetDigest {
  const lines = contentToText(m.content).split("\n");
  const at = lines.findIndex((l) => l.startsWith(TASK_EXCERPT_FORGET_HEADING));
  const out: ExcerptForgetDigest = { lines: [], omitted: 0 };
  if (at < 0) return out;
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith(TASK_EXCERPT_CLOSE)) break;
    const omitted = OMITTED_LINE.exec(line);
    if (omitted) out.omitted += Number(omitted[1]);
    else if (line.trim().length > 0) out.lines.push(line);
  }
  return out;
}

/** 直近 EXCERPT_FORGET_LINES_KEPT 行に切る */
export function capForgetDigest(d: ExcerptForgetDigest, max = EXCERPT_FORGET_LINES_KEPT): ExcerptForgetDigest {
  if (d.lines.length <= max) return d;
  return { lines: d.lines.slice(d.lines.length - max), omitted: d.omitted + d.lines.length - max };
}

/**
 * 置き換える範囲と、 範囲の中で残すものを決める。 落とすものが無ければ null。
 * @param newForgetLines 今回の整理 (段階 0〜2) の忘却の記録の行 (抜粋の忘却の記録に足す。 system の記録は増やさない)
 */
export function planTaskExcerpt(
  messages: readonly Message[],
  keepRecentToolUses: number,
  doc: TaskHandoffDoc,
  newForgetLines: readonly string[],
): ExcerptPlan | null {
  let start = 0;
  while (start < messages.length && isTaskPointerMessage(messages[start])) start++;
  let end = Math.max(start, protectedTailStart(messages, keepRecentToolUses));
  // ツール呼び出しが無い履歴では保護部分が「最後のモデルの発言」 から始まり、 それが要約のことがある (2026-11-07 の形)。
  // 要約・前の抜粋・忘却の記録は作り直せる派生物なので、 保護部分の頭にあれば範囲に含める (ツールの組の頭にはならない)
  while (end < messages.length && isDerived(messages[end])) end++;
  const requests = new Set(doc.requests.map((r) => r.text.replace(/\r/g, "").trim()));
  const counts: ExcerptCounts = {
    summaries: 0,
    excerpts: 0,
    forgetNotes: 0,
    userMessages: 0,
    otherMessages: 0,
    keptMessages: 0,
  };
  const forget: ExcerptForgetDigest = { lines: [], omitted: 0 };
  const keep: boolean[] = [];
  let i = start;
  while (i < end) {
    const m = messages[i];
    if (hasToolCalls(m)) {
      let groupEnd = i + 1;
      while (groupEnd < end && messages[groupEnd].role === "tool") groupEnd++;
      const kept = (m.tool_calls ?? []).some((c) => EXCERPT_KEPT_TOOL_NAMES.has(c.function.name));
      for (let k = i; k < groupEnd; k++) keep.push(kept);
      if (kept) counts.keptMessages += groupEnd - i;
      else counts.otherMessages += groupEnd - i;
      i = groupEnd;
      continue;
    }
    let kept: boolean;
    if (isTaskPointerMessage(m)) {
      kept = true;
    } else if (isTaskHandoffExcerptMessage(m)) {
      kept = false;
      counts.excerpts++;
      const d = excerptForget(m);
      forget.omitted += d.omitted;
      forget.lines.push(...d.lines);
    } else if (isReductionSummaryMessage(m)) {
      kept = false;
      counts.summaries++;
    } else if (isTombstone(m)) {
      kept = false;
      counts.forgetNotes++;
      forget.lines.push(...tombstoneLines(m));
    } else if (m.role === "system") {
      kept = true;
    } else if (m.role === "user") {
      if (m.ephemeral === true) {
        kept = false;
        counts.otherMessages++;
      } else if (isTextOnly(m) && requests.has(messageText(m).replace(/\r/g, "").trim())) {
        kept = false;
        counts.userMessages++;
      } else {
        kept = true;
      }
    } else {
      kept = false;
      counts.otherMessages++;
    }
    if (kept) counts.keptMessages++;
    keep.push(kept);
    i++;
  }
  if (!keep.some((k) => !k)) return null;
  forget.lines.push(...newForgetLines);
  return { start, end, keep, counts, forget: capForgetDigest(forget) };
}

/** 抜粋のメッセージの本文 */
export function renderExcerptMessage(doc: TaskHandoffDoc, mdPath: string, plan: ExcerptPlan): string {
  return renderTaskHandoffExcerpt(doc, mdPath, undefined, plan.forget);
}

/** 写しの範囲を抜粋 1 件 (範囲の先頭) と残すものに置き換える。 入力は書き換えない */
export function applyTaskExcerpt(messages: readonly Message[], plan: ExcerptPlan, excerptText: string): Message[] {
  const kept = messages.slice(plan.start, plan.end).filter((_, k) => plan.keep[k]);
  return [
    ...messages.slice(0, plan.start),
    { role: "user", content: excerptText },
    ...kept,
    ...messages.slice(plan.end),
  ];
}
