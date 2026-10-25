/**
 * コンテキスト整理の段階 3: 要約 (docs/context-reduction-redesign.md §5.6 / §5.8。 整理の作り直し タスク 6)。
 *
 * 段階 0〜2 (reduction-stages.ts) の後もまだ目標と最低量に届かないときだけ使う。 流れ:
 *   1. selectSummaryRange(): 段階 0〜2 の後の写しで、 要約する範囲 (足りない量を満たす最小の範囲) を決める
 *   2. requestSummary(): 書き換え前の現在の履歴 (= 次の本体呼び出しで送るはずの並び) の末尾に要約の指示を 1 件足して、
 *      脇の呼び出し (目的 summarize) で送る。 前方一致でサーバのキャッシュがそのまま使える
 *   3. applySummaryToCopy(): 写しの範囲の中の、 利用者の発言の間にあるモデルの発言とツール結果を、
 *      区間ごとの要約 (assistant メッセージ) に置き換える。 利用者の発言は原文のまま元の位置に残す
 *   4. buildStateHandover(): 状態の渡し直し (最近触ったファイル・いまの作業) の文面を作る。
 *      MessageHistory.queueStateHandover() に渡すと、 次の状態通知に 1 回だけ添えられる
 *
 * 1・3・4 は写しに対する純粋な関数 (入力の配列もメッセージも書き換えない)。 2 だけが LLM を呼ぶ。
 * 履歴の差し替え・忘却の記録の挿入・発火はここではしない (タスク 7・8)。
 */
import {
  type ChatParams,
  type ChatWithToolsParams,
  collectResponse,
  type LLMProvider,
  type Message,
  type TokenUsage,
} from "../providers/base-provider.js";
import type { ContextBudget } from "./context-budget.js";
import { findToolPairingError } from "./message-history.js";
import { PROTECTED_TOOL_NAMES, describeToolCall, estimateSentMessageTokens, oneLine } from "./reduction-stages.js";
import { sideCall } from "./side-call.js";
import { estimateMessageTokens } from "./token-counter.js";

// ─── 要約の型 (§5.6) ───

/**
 * 全体の要約の見出し (Claude Code の要約の型に合わせる。 見出しは英語、 中身は会話の言語)。
 * Claude Code の型にある「利用者の発言の一覧」 は入れない (利用者の発言は原文のまま履歴に残るため)。
 */
export const SUMMARY_HEADINGS = [
  "Primary request and intent",
  "Key technical concepts",
  "Files and code sections",
  "Errors and fixes",
  "Problem solving",
  "Pending tasks",
  "Current work",
  "Next step",
] as const;
export type SummaryHeading = (typeof SUMMARY_HEADINGS)[number];

/** 見出しごとに書く中身 (指示に載せる) */
const HEADING_GUIDE: Record<SummaryHeading, string> = {
  "Primary request and intent":
    "what the user asked for and what they want to achieve, including later changes of mind",
  "Key technical concepts": "technologies, frameworks, rules and design decisions that matter for the work",
  "Files and code sections":
    "files read, created or changed, with exact absolute paths, function names and line numbers, and why each matters",
  "Errors and fixes": "errors met and how each was fixed, with the exact error messages; user feedback on mistakes",
  "Problem solving": "problems solved and investigations still open",
  "Pending tasks": "tasks the user asked for that are not done yet",
  "Current work": "exactly what you were doing right before the end of the summarized part",
  "Next step": "only the next step that directly continues the current work (none if the work was finished)",
};

/** 要約を置いた assistant メッセージの目印。 次の整理の範囲はこの次から始める (要約の要約をしない) */
export const SUMMARY_MESSAGE_OPEN = "<summary-of-earlier-turns>";
export const SUMMARY_MESSAGE_CLOSE = "</summary-of-earlier-turns>";

/**
 * 要約のメッセージの先頭に必ず入れる注記。 要約は assistant の発言として置くので、 モデルが
 * 「この形で答えるもの」 と真似しないよう、 ハーネスが置いた記録であって返答の手本ではないと明記する。
 */
const SUMMARY_MESSAGE_NOTE =
  "The harness replaced my earlier replies, tool calls and tool results at this point with the summary below " +
  "to keep the context small. It is a record of what I did, not an example of how to reply. " +
  "Never write replies in this form.";

/** 全体の要約 (8 見出し) の前に置く見出し */
const OVERALL_SUMMARY_TITLE = "# Summary of the conversation so far";

export function isReductionSummaryMessage(m: Message): boolean {
  return m.role === "assistant" && typeof m.content === "string" && m.content.startsWith(SUMMARY_MESSAGE_OPEN);
}

// ─── 1. 要約の範囲 ───

/**
 * 範囲を決めるときに見込む、 要約 1 件の大きさ (実際の大きさは呼ぶまで分からない)。
 * 区間ごとの短い要約と、 最後の区間に付ける全体の要約 (8 見出し。 設計書の見込み 2〜4k トークン)。
 * 呼んだ後の実際の減った量は applySummaryToCopy() が返すので、 呼び出し側はそれで目標を確かめ直す。
 */
export const ESTIMATED_SEGMENT_SUMMARY_TOKENS = 256;
export const ESTIMATED_OVERALL_SUMMARY_TOKENS = 3_072;

export interface SummaryRangeInput {
  /** 段階 0〜2 の後の写し (ReductionStagesResult.messages) */
  messages: readonly Message[];
  /** 写しの各メッセージの元の履歴での添字 (ReductionStagesResult.originalIndices) */
  originalIndices: readonly number[];
  /** 元の履歴 (getRawMessages()) の件数 */
  originalLength: number;
  /** K (TIER_CONTEXT_BUDGETS[tier].keepRecentToolUses)。 直近 K 回のツール呼び出しより後ろは範囲に入れない */
  keepRecentToolUses: number;
  /** 段階 0〜2 の後に足りない量 (ReductionStagesResult.shortfall) */
  shortfall: { toTarget: number; toMinimum: number };
}

/** 要約で 1 つのメッセージに置き換える区間 (利用者の発言・system ノート・保護するツールの組の間の連続) */
export interface SummarySegment {
  /** 写しでの範囲 [start, end) */
  start: number;
  end: number;
  /** 元の履歴での範囲 [originalStart, originalEnd) (段階 0〜2 が消したメッセージも含む) */
  originalStart: number;
  originalEnd: number;
  /** 写しでの送る形の推定トークン数 */
  tokens: number;
}

export interface SummaryRange {
  /** 写しでの範囲 [start, end) */
  start: number;
  end: number;
  /** 元の履歴での範囲 [originalStart, originalEnd) */
  originalStart: number;
  originalEnd: number;
  /** 範囲の中の区間 (古い順。 1 つ以上) */
  segments: SummarySegment[];
  /** 減らす必要のある量 = max(目標まで, 最低量まで) */
  requiredTokens: number;
  /** 見込みの減る量 (区間の大きさ − 見込みの要約の大きさ) */
  estimatedFreedTokens: number;
  /**
   * 見込みで足りる範囲が見つかったか。 false なら、 範囲に入れられる最大まで広げても見込みで足りない
   * (それでも減る分は減るので範囲は返す。 足りるかどうかの扱いは呼び出し側が決める)
   */
  meetsShortfall: boolean;
}

export type SummaryRangeResult =
  | { ok: true; range: SummaryRange }
  | { ok: false; reason: "not-needed" | "nothing-to-summarize"; detail: string };

type Kind = "kept" | "summarizable";

function hasToolCalls(m: Message | undefined): boolean {
  return !!m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

/**
 * 写しの各メッセージを、 範囲の中で原文のまま残すもの (kept) と要約に置き換えるもの (summarizable) に分ける。
 * 残すもの: 利用者の発言 (揮発でないもの)、 system ノート (圧縮要約・忘却の記録)、 保護するツール (§5.1) を含む応答の組。
 */
function classify(messages: readonly Message[]): Kind[] {
  const kinds: Kind[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (hasToolCalls(m)) {
      let end = i + 1;
      while (end < messages.length && messages[end].role === "tool") end++;
      const kept = (m.tool_calls ?? []).some((c) => PROTECTED_TOOL_NAMES.has(c.function.name));
      for (let k = i; k < end; k++) kinds.push(kept ? "kept" : "summarizable");
      i = end;
      continue;
    }
    // ハーネスの促し (揮発の印 Message.ephemeral) は利用者の発言として残さない
    const kept = m.role === "system" || (m.role === "user" && m.ephemeral !== true);
    kinds.push(kept ? "kept" : "summarizable");
    i++;
  }
  return kinds;
}

/**
 * 範囲に入れてよい終わり (写しの添字。 この位置から後ろが保護部分)。
 * 直近 K 回のツール呼び出しと最新の応答の組は残す (reduction-stages.ts と同じ数え方)。
 * ツール呼び出しが 1 つも無ければ、 最後のモデルの発言から後ろを残す。
 */
function protectedTailStart(messages: readonly Message[], keepRecentToolUses: number): number {
  const callHeads: number[] = [];
  let lastBatchHead = -1;
  for (let i = 0; i < messages.length; i++) {
    if (!hasToolCalls(messages[i])) continue;
    lastBatchHead = i;
    for (const _call of messages[i].tool_calls ?? []) callHeads.push(i);
  }
  if (lastBatchHead < 0) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
    return messages.length;
  }
  const k = Math.max(0, keepRecentToolUses);
  const recentHead = k > 0 ? callHeads[Math.max(0, callHeads.length - k)] : lastBatchHead;
  return Math.min(lastBatchHead, recentHead);
}

/** ここで切ってもツールの対を分けない位置か (replaceOlderMessages と同じ扱い) */
function isPairSafeBoundary(messages: readonly Message[], e: number): boolean {
  if (e >= messages.length) return true;
  return messages[e].role !== "tool" && !hasToolCalls(messages[e - 1]);
}

/** 要約のメッセージ 1 件の包み (目印・注記) の分 */
function wrapperTokens(): number {
  return estimateMessageTokens([
    { role: "assistant", content: `${SUMMARY_MESSAGE_OPEN}\n${SUMMARY_MESSAGE_NOTE}\n\n${SUMMARY_MESSAGE_CLOSE}` },
  ]);
}

/**
 * 要約の範囲を決める (§5.6)。 範囲は履歴の先頭 (既存の要約があればその次) から保護部分の手前までのうち、
 * 見込みの減る量が足りない量 (目標まで・最低量までの大きい方) を満たす最小のもの。
 * 終わりはツールの対を分けない位置に寄せ、 要約に置き換えるメッセージで終わる位置だけを候補にする。
 */
export function selectSummaryRange(input: SummaryRangeInput): SummaryRangeResult {
  const { messages, originalIndices } = input;
  if (originalIndices.length !== messages.length) {
    throw new Error("[reduction-summary] originalIndices の長さが写しと一致しません");
  }
  const requiredTokens = Math.max(input.shortfall.toTarget, input.shortfall.toMinimum, 0);
  if (requiredTokens <= 0) {
    return { ok: false, reason: "not-needed", detail: "段階 0〜2 で目標と最低量を満たしています" };
  }

  const kinds = classify(messages);
  const limit = protectedTailStart(messages, input.keepRecentToolUses);
  let start = 0;
  for (let i = limit - 1; i >= 0; i--) {
    if (isReductionSummaryMessage(messages[i])) {
      start = i + 1;
      break;
    }
  }

  const segmentCost = ESTIMATED_SEGMENT_SUMMARY_TOKENS + wrapperTokens();
  let sum = 0;
  let segmentCount = 0;
  let chosen: { end: number; freed: number } | null = null;
  let largest: { end: number; freed: number } | null = null;
  for (let i = start; i < limit; i++) {
    if (kinds[i] !== "summarizable") continue;
    if (i === start || kinds[i - 1] !== "summarizable") segmentCount++;
    sum += estimateSentMessageTokens([messages[i]]);
    const end = i + 1;
    if (!isPairSafeBoundary(messages, end)) continue;
    const freed = sum - segmentCount * segmentCost - ESTIMATED_OVERALL_SUMMARY_TOKENS;
    largest = { end, freed };
    if (freed >= requiredTokens) {
      chosen = largest;
      break;
    }
  }
  const pick = chosen ?? largest;
  if (!pick || pick.freed <= 0) {
    return {
      ok: false,
      reason: "nothing-to-summarize",
      detail:
        `要約してよい範囲 (写しの ${start}〜${limit} 件目) を要約しても減る見込みがありません` +
        ` (見込み ${pick ? pick.freed.toLocaleString("en-US") : 0} トークン)`,
    };
  }

  const originalOf = (copyIndex: number): number =>
    copyIndex >= messages.length ? input.originalLength : originalIndices[copyIndex];
  const originalStart = start === 0 ? 0 : originalIndices[start - 1] + 1;
  const originalEnd = originalOf(pick.end);
  const segments: SummarySegment[] = [];
  for (let i = start; i < pick.end; i++) {
    if (kinds[i] !== "summarizable") continue;
    let end = i + 1;
    while (end < pick.end && kinds[end] === "summarizable") end++;
    segments.push({
      start: i,
      end,
      originalStart: i === start ? originalStart : originalIndices[i - 1] + 1,
      originalEnd: end === pick.end ? originalEnd : originalIndices[end],
      tokens: estimateSentMessageTokens(messages.slice(i, end)),
    });
    i = end - 1;
  }

  return {
    ok: true,
    range: {
      start,
      end: pick.end,
      originalStart,
      originalEnd,
      segments,
      requiredTokens,
      estimatedFreedTokens: pick.freed,
      meetsShortfall: chosen !== null,
    },
  };
}

// ─── 2. 要約の呼び出し ───

/** 本体呼び出しと同じ送り方 (method と params)。 params.messages は getMessages() の並び */
export type MainCallRequest =
  | { method: "chat"; params: ChatParams }
  | { method: "chatWithTools"; params: ChatWithToolsParams };

export interface SummaryCallInput {
  provider: LLMProvider;
  /**
   * 次の本体呼び出しで送るはずのもの (同じ model・同じツール定義・同じサンプリング・同じ思考設定、
   * messages = getMessages())。 ここに要約の指示を 1 件足し、 出力上限だけを差し替えて送る
   */
  request: MainCallRequest;
  /** 元の履歴 (getRawMessages())。 request.params.messages は [固定の system, ...これを送る形にしたもの] であること */
  history: readonly Message[];
  range: SummaryRange;
  /** 整理前の P (要約の呼び出しの入力 ≒ P + 指示) */
  promptTokens: number;
  budget: ContextBudget;
}

export type SummaryFailureReason =
  /** 送り直した 2 回目もツールを呼んだ (理由は 2 回目の問題で決める) */
  | "tool-call"
  /** 送り直した 2 回目も型 (区間の数・8 見出し) が揃わなかった */
  | "format"
  /** 出力上限で切れた (思考で使い切った場合を含む)。 同じ上限で送り直しても同じなので再送しない */
  | "length"
  /** 枠の残りが小さすぎて要約の出力を受け取れない */
  | "no-room";

export interface SummaryAttempt {
  finishReason: string;
  usage?: TokenUsage;
  /** その回の問題 (成功した回は空) */
  problems: string[];
}

export type SummaryCallResult =
  | { ok: true; summary: ParsedSummary; attempts: SummaryAttempt[]; maxTokens: number; durationMs: number }
  | {
      ok: false;
      reason: SummaryFailureReason;
      detail: string;
      attempts: SummaryAttempt[];
      maxTokens: number;
      durationMs: number;
    };

/** 要約の出力に最低限要る上限 (これより小さければ呼ばずに失敗) */
export const MIN_SUMMARY_OUTPUT_TOKENS = 1_024;

/** 送り直しの理由 (1 回目の問題) */
export type RetryCause = { kind: "tool-call"; toolNames: string[] } | { kind: "format"; problems: string[] };

/**
 * 要約を得る (§5.6)。 書き換え前の現在の履歴 (request.params.messages) の末尾に要約の指示 (user) を 1 件足して、
 * sideCall("summarize") で送る。 前方は前回の本体呼び出しと同じなので、 サーバは末尾の読み込みと出力だけで済む。
 *
 * - 思考の設定は本体と同じ (request.params をそのまま使い、 disableThinking を足さない)。 思考をオフにすると
 *   チャットテンプレートが system の先頭を変え、 全体の読み直しになる。
 * - ツール定義も本体と同じものを渡す (並びを変えない)。 指示で「ツールを呼ぶな」 と書く。
 * - 出力上限は min(O, W − P − 指示 − M)。 規則 1 の発火時でも S − 指示 以上が残る (§4.4)。
 * - ツールを呼んだ・型が揃わないときは 1 回だけ指示を強めて送り直す (同じ並び + 強めた指示)。 だめなら失敗を返す。
 *   出力上限で切れたときは送り直さない。 別の手段 (思考オフ・別の要約器) には切り替えない。
 * - provider のエラー・中断 (signal) は例外のまま投げる。
 */
export async function requestSummary(input: SummaryCallInput): Promise<SummaryCallResult> {
  const { request, history, range, budget } = input;
  assertRequestMatchesHistory(request.params.messages, history);
  const startedAt = Date.now();
  const attempts: SummaryAttempt[] = [];
  let retry: RetryCause | null = null;
  let maxTokens = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const instruction: Message = { role: "user", content: buildSummaryInstruction(history, range, retry) };
    const room =
      budget.contextWindow - input.promptTokens - estimateMessageTokens([instruction]) - budget.estimateMarginTokens;
    maxTokens = Math.min(budget.outputTokenLimit, room);
    if (maxTokens < MIN_SUMMARY_OUTPUT_TOKENS) {
      return {
        ok: false,
        reason: "no-room",
        detail:
          `枠の残りが要約の出力に足りません (W ${budget.contextWindow.toLocaleString("en-US")} − ` +
          `P ${input.promptTokens.toLocaleString("en-US")} − 指示 − 余白 M = ${room.toLocaleString("en-US")} トークン)`,
        attempts,
        maxTokens,
        durationMs: Date.now() - startedAt,
      };
    }
    const messages = [...request.params.messages, instruction];
    const gen =
      request.method === "chatWithTools"
        ? sideCall("summarize", input.provider, {
            method: "chatWithTools",
            params: { ...request.params, messages, maxTokens },
          })
        : sideCall("summarize", input.provider, { method: "chat", params: { ...request.params, messages, maxTokens } });
    const res = await collectResponse(gen);

    if (res.toolCalls.length > 0) {
      const toolNames = res.toolCalls.map((c) => c.function.name);
      attempts.push({
        finishReason: res.finishReason,
        usage: res.usage,
        problems: [`ツールを呼びました (${toolNames.join(", ")})`],
      });
      retry = { kind: "tool-call", toolNames };
      continue;
    }
    if (res.finishReason === "length") {
      attempts.push({ finishReason: res.finishReason, usage: res.usage, problems: ["出力上限で切れました"] });
      return {
        ok: false,
        reason: "length",
        detail:
          `要約の出力が上限 ${maxTokens.toLocaleString("en-US")} トークンで切れました ` +
          `(finishReason=length, 本文 ${res.content.length} 字, 出力 ${res.usage?.completionTokens ?? "不明"} トークン)`,
        attempts,
        maxTokens,
        durationMs: Date.now() - startedAt,
      };
    }
    const parsed = parseSummaryOutput(res.content, range.segments.length);
    if (!parsed.ok) {
      attempts.push({ finishReason: res.finishReason, usage: res.usage, problems: parsed.problems });
      retry = { kind: "format", problems: parsed.problems };
      continue;
    }
    attempts.push({ finishReason: res.finishReason, usage: res.usage, problems: [] });
    return { ok: true, summary: parsed.summary, attempts, maxTokens, durationMs: Date.now() - startedAt };
  }

  const last = retry as RetryCause;
  return {
    ok: false,
    reason: last.kind,
    detail: `要約を 2 回求めましたが得られませんでした: ${attempts.map((a, i) => `${i + 1} 回目 ${a.problems.join(" / ")}`).join("。 ")}`,
    attempts,
    maxTokens,
    durationMs: Date.now() - startedAt,
  };
}

/** request の並びが元の履歴を送る形にしたものか (位置の対応が崩れていれば目印が別のメッセージを指してしまう) */
function assertRequestMatchesHistory(sent: readonly Message[], history: readonly Message[]): void {
  const mismatch =
    sent.length !== history.length + 1 ||
    sent[0]?.role !== "system" ||
    history.some((m, i) => sent[i + 1].role !== m.role || sent[i + 1].tool_call_id !== m.tool_call_id);
  if (mismatch) {
    throw new Error(
      "[reduction-summary] 要約の呼び出しの並び (getMessages()) が元の履歴 (getRawMessages()) と対応していません",
    );
  }
}

// ─── 指示の文面 ───

function textOf(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text as string)
    .join(" ");
}

function excerpt(text: string): string {
  return oneLine(text, 80).replace(/"/g, "'");
}

/**
 * 元の履歴の 1 件を、 モデルが見つけられる言葉で指し示す (境界の目印)。
 * 並びの途中に印は入れられない (前方が変わる) ので、 役割・中身の書き出し・利用者の発言の通し番号で示す。
 * ツール呼び出しの id はチャットテンプレートに描画されないので使わない。
 */
export function describeMessageAnchor(history: readonly Message[], index: number): string {
  const m = history[index];
  if (m.role === "user") {
    const ordinal = history.slice(0, index + 1).filter((x) => x.role === "user").length;
    return `user message #${ordinal} (it begins: "${excerpt(textOf(m))}")`;
  }
  if (m.role === "system") return `the harness note that begins: "${excerpt(textOf(m))}"`;
  if (m.role === "tool") {
    for (let i = index - 1; i >= 0; i--) {
      const call = history[i].tool_calls?.find((c) => c.id === m.tool_call_id);
      if (call) return `the tool result of your call ${describeToolCall(call.function.name, call.function.arguments)}`;
    }
    return `the tool result that begins: "${excerpt(textOf(m))}"`;
  }
  if (hasToolCalls(m)) {
    const calls = (m.tool_calls ?? []).map((c) => describeToolCall(c.function.name, c.function.arguments)).join(", ");
    return `your tool call ${calls}`;
  }
  if (isReductionSummaryMessage(m)) return "the earlier summary";
  return `your reply that begins: "${excerpt(textOf(m))}"`;
}

/**
 * 要約の指示 (英語。 モデル向けの文は英語が正本)。 範囲の境界、 区間ごとの境界、 出力の型を書く。
 * retry があれば、 1 回目の問題を先頭に書いて指示を強める。
 */
export function buildSummaryInstruction(
  history: readonly Message[],
  range: SummaryRange,
  retry: RetryCause | null = null,
): string {
  const lines: string[] = ["<context-summary-request>"];
  if (retry?.kind === "tool-call") {
    lines.push(
      `IMPORTANT: Your previous answer to this request called a tool (${retry.toolNames.join(", ")}). ` +
        "Tools are not available for this request and the call was not executed. " +
        "Do not call any tool. Answer again with text only, in the format below.",
      "",
    );
  } else if (retry?.kind === "format") {
    lines.push(
      "IMPORTANT: Your previous answer to this request did not follow the required format:",
      ...retry.problems.map((p) => `- ${p}`),
      "Answer again and follow the format below exactly.",
      "",
    );
  }
  const startText =
    range.originalStart === 0
      ? "the start of the conversation"
      : `right after ${describeMessageAnchor(history, range.originalStart - 1)}`;
  const endAnchor = describeMessageAnchor(history, range.originalEnd - 1);
  lines.push(
    "This request comes from the harness, not from the user. The conversation has become too long, " +
      "so a part of it will be replaced with the summary you write now.",
    "",
    "Do not call any tools. Tool calls are not executed in this request. Reply with text only.",
    "",
    "## Part to summarize",
    `From ${startText} up to and including ${endAnchor}.`,
  );
  if (range.originalEnd < history.length) {
    lines.push(
      `Everything after that, starting with ${describeMessageAnchor(history, range.originalEnd)}, stays as it is. Do not summarize it.`,
    );
  }
  lines.push(
    "The user's messages in this part stay word for word in the history, so do not repeat or list them. " +
      "Summarize only your own replies, your tool calls and their results, divided into these segments:",
    "",
  );
  range.segments.forEach((seg, k) => {
    const from =
      seg.originalStart === range.originalStart
        ? startText
        : `right after ${describeMessageAnchor(history, seg.originalStart - 1)}`;
    const to =
      k === range.segments.length - 1
        ? `up to and including ${describeMessageAnchor(history, seg.originalEnd - 1)}`
        : `up to (not including) ${describeMessageAnchor(history, seg.originalEnd)}`;
    lines.push(`${k + 1}. From ${from}, ${to}.`);
  });
  lines.push(
    "",
    "## Output format",
    `First, for each of the ${range.segments.length} segments in order, a short summary inside <segment n="N"></segment> ` +
      "(N = the segment number): what you did in that segment, the results, decisions, exact file paths and errors. " +
      "Keep each one short (a few sentences).",
    "Then one overall summary inside <summary></summary> covering the whole conversation up to the end of the summarized part " +
      "(including any earlier summaries), with exactly these 8 headings in this order, each on its own line as '## <heading>':",
  );
  SUMMARY_HEADINGS.forEach((h, k) => {
    lines.push(`${k + 1}. ## ${h} — ${HEADING_GUIDE[h]}`);
  });
  lines.push(
    "",
    "Write the headings in English exactly as above, and the contents in the language of the conversation. " +
      "Keep file paths, function names, line numbers, commands and error messages exact; do not round or shorten them. " +
      'If a heading has nothing to report, write "None" under it.',
    "Write nothing outside the <segment> and <summary> tags.",
    "</context-summary-request>",
  );
  return lines.join("\n");
}

// ─── 出力の検査 ───

export interface ParsedSummary {
  /** 区間ごとの短い要約 (区間の順) */
  segments: string[];
  /** 全体の要約の見出しごとの中身 */
  sections: Record<SummaryHeading, string>;
  /** タグの外にあった文字数 (捨てた分。 記録に出す) */
  extraTextChars: number;
}

export type SummaryParseResult = { ok: true; summary: ParsedSummary } | { ok: false; problems: string[] };

/** 見出しの行 (`## Current work`、 `### 7. Current work` など) から見出しの名前を取る */
function headingOf(line: string): SummaryHeading | null {
  const m = /^#{1,6}\s*(?:\d+[.)]\s*)?(.+?)\s*#*\s*$/.exec(line.trim());
  if (!m) return null;
  const name = m[1].replace(/\*\*/g, "").replace(/:$/, "").trim().toLowerCase();
  return SUMMARY_HEADINGS.find((h) => h.toLowerCase() === name) ?? null;
}

/**
 * 要約の出力を検査して取り出す。 区間の要約が 1〜N まで順に揃い、 全体の要約に 8 見出しが順に 1 回ずつあり、
 * どれも中身があること。 揃わなければ問題の一覧を返す (黙って受け入れない。 呼び出し側は 1 回だけ送り直す)。
 * 8 見出し以外の見出しの行 (ファイル名の小見出しなど) は直前の見出しの中身として扱う。
 */
export function parseSummaryOutput(raw: string, segmentCount: number): SummaryParseResult {
  // 本文に混ざって返る思考 (<think>…</think>) は要約ではないので除く
  const text = raw.replace(/^\s*<think>[\s\S]*?<\/think>/, "");
  const problems: string[] = [];

  const segmentRe = /<segment\s+n\s*=\s*"?(\d+)"?\s*>([\s\S]*?)<\/segment>/g;
  const found: Array<{ n: number; body: string }> = [];
  for (const m of text.matchAll(segmentRe)) found.push({ n: Number(m[1]), body: m[2].trim() });
  const order = found.map((f) => f.n).join(",");
  const expected = Array.from({ length: segmentCount }, (_, i) => i + 1).join(",");
  if (order !== expected) {
    problems.push(
      `<segment> は n=1〜${segmentCount} を順に 1 つずつ書く必要があります (実際: ${order.length > 0 ? `n=${order}` : "なし"})`,
    );
  }
  found.forEach((f) => {
    if (f.body.length === 0) problems.push(`<segment n="${f.n}"> が空です`);
  });

  const summaries = [...text.matchAll(/<summary>([\s\S]*?)<\/summary>/g)];
  const sections = {} as Record<SummaryHeading, string>;
  if (summaries.length !== 1) {
    problems.push(`<summary> は 1 つだけ書く必要があります (実際: ${summaries.length} 個)`);
  } else {
    const seen: SummaryHeading[] = [];
    let current: SummaryHeading | null = null;
    const bodies = new Map<SummaryHeading, string[]>();
    for (const line of summaries[0][1].split(/\r?\n/)) {
      const h = headingOf(line);
      if (h) {
        if (bodies.has(h)) problems.push(`見出し "${h}" が 2 回あります`);
        seen.push(h);
        current = h;
        bodies.set(h, []);
        continue;
      }
      if (current) bodies.get(current)?.push(line);
    }
    const missing = SUMMARY_HEADINGS.filter((h) => !bodies.has(h));
    if (missing.length > 0) problems.push(`見出しが足りません: ${missing.join(", ")}`);
    const unique = seen.filter((h, i) => seen.indexOf(h) === i);
    const expectedOrder = SUMMARY_HEADINGS.filter((h) => bodies.has(h));
    if (unique.join("|") !== expectedOrder.join("|")) problems.push("見出しの順が決まった順ではありません");
    for (const h of SUMMARY_HEADINGS) {
      const body = (bodies.get(h) ?? []).join("\n").trim();
      if (bodies.has(h) && body.length === 0) problems.push(`見出し "${h}" の中身が空です`);
      sections[h] = body;
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  const outside = text.replace(segmentRe, "").replace(/<summary>[\s\S]*?<\/summary>/g, "");
  return {
    ok: true,
    summary: { segments: found.map((f) => f.body), sections, extraTextChars: outside.trim().length },
  };
}

// ─── 3. 写しへの当てはめ ───

export interface SummaryApplication {
  /** 要約を当てはめた写し。 ツールの対の検証を通っている */
  messages: Message[];
  /** 送る形の推定で減った量 (要約の後の実際の値。 範囲を決めたときの見込みではない) */
  freedTokens: number;
  /**
   * 入力の写しの添字 → 当てはめ後の添字。 要約に置き換えたメッセージは、 その区間の要約の位置を指す。
   * 忘却の記録 (firstForgottenIndex) を置き直すのに使う
   */
  newIndexOf: number[];
  /** 要約を置いた位置 (当てはめ後の添字。 区間の順) */
  summaryIndices: number[];
}

/** 区間の要約を置く assistant メッセージの本文。 最後の区間には全体の要約 (8 見出し) も付ける */
export function renderSummaryMessage(segmentText: string, sections: Record<SummaryHeading, string> | null): string {
  const parts = [SUMMARY_MESSAGE_OPEN, SUMMARY_MESSAGE_NOTE, "", segmentText.trim()];
  if (sections) {
    parts.push("", OVERALL_SUMMARY_TITLE);
    for (const h of SUMMARY_HEADINGS) parts.push(`## ${h}`, sections[h], "");
    parts.pop();
  }
  parts.push(SUMMARY_MESSAGE_CLOSE);
  return parts.join("\n");
}

/**
 * 写し (段階 0〜2 の後) の範囲の区間を、 区間ごとの要約の assistant メッセージに置き換える (§5.6)。
 * 利用者の発言・system ノート・保護するツールの組は原文のまま元の位置に残る。 入力は書き換えない。
 *
 * 置き方 (2026-10-25 タスク 6 で決定): assistant メッセージとして区間の位置に置く。
 * 履歴の途中の system は Qwen 系のテンプレートが受け付けず、 openai-compat が先頭の system に寄せてしまう
 * (先頭が変わる)。 user にすると利用者の言葉に見え、 「利用者の発言は原文のまま」 と食い違う。
 */
export function applySummaryToCopy(
  messages: readonly Message[],
  range: SummaryRange,
  summary: ParsedSummary,
): SummaryApplication {
  if (summary.segments.length !== range.segments.length) {
    throw new Error(
      `[reduction-summary] 区間の要約の数 (${summary.segments.length}) が区間の数 (${range.segments.length}) と一致しません`,
    );
  }
  const out: Message[] = [];
  const newIndexOf: number[] = new Array(messages.length);
  const summaryIndices: number[] = [];
  let k = 0;
  for (let i = 0; i < messages.length; i++) {
    const seg = range.segments[k];
    if (seg && i === seg.start) {
      const isLast = k === range.segments.length - 1;
      summaryIndices.push(out.length);
      for (let j = seg.start; j < seg.end; j++) newIndexOf[j] = out.length;
      out.push({
        role: "assistant",
        content: renderSummaryMessage(summary.segments[k], isLast ? summary.sections : null),
      });
      i = seg.end - 1;
      k++;
      continue;
    }
    newIndexOf[i] = out.length;
    out.push(messages[i]);
  }
  const pairingError = findToolPairingError(out);
  if (pairingError) {
    throw new Error(`[reduction-summary] 要約を当てはめた写しのツールの対が壊れています: ${pairingError}`);
  }
  return {
    messages: out,
    freedTokens: estimateSentMessageTokens(messages) - estimateSentMessageTokens(out),
    newIndexOf,
    summaryIndices,
  };
}

// ─── 4. 状態の渡し直し ───

/** 状態の渡し直しに並べるファイルの上限 (超えた分は件数で示す) */
export const RECENT_FILES_LISTED = 20;

/**
 * 要約した部分 (元の履歴の範囲) でツールが触ったファイル (引数 file_path) を新しい順に、 重複を除いて返す。
 * 範囲より後ろ (保護部分) は履歴にそのまま残るので含めない。
 */
export function collectRecentFiles(
  history: readonly Message[],
  range: Pick<SummaryRange, "originalStart" | "originalEnd">,
  caseInsensitivePaths: boolean = process.platform === "win32",
): { paths: string[]; omitted: number } {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let i = range.originalEnd - 1; i >= range.originalStart; i--) {
    const calls = history[i]?.tool_calls ?? [];
    for (let c = calls.length - 1; c >= 0; c--) {
      let path: unknown;
      try {
        path = (JSON.parse(calls[c].function.arguments || "{}") as Record<string, unknown>).file_path;
      } catch {
        continue;
      }
      if (typeof path !== "string" || path.trim().length === 0) continue;
      const key = caseInsensitivePaths ? path.replace(/\\/g, "/").toLowerCase() : path;
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(path);
    }
  }
  return { paths: paths.slice(0, RECENT_FILES_LISTED), omitted: Math.max(0, paths.length - RECENT_FILES_LISTED) };
}

/**
 * 状態の渡し直しの文面 (§5.6)。 MessageHistory.queueStateHandover() に渡すと、 次の状態通知に 1 回だけ添えられる。
 * 中身は要約した部分で触ったファイル (パス一覧) と、 要約の Current work。
 */
export function buildStateHandover(
  history: readonly Message[],
  range: Pick<SummaryRange, "originalStart" | "originalEnd">,
  summary: ParsedSummary,
  caseInsensitivePaths?: boolean,
): string {
  const files = collectRecentFiles(history, range, caseInsensitivePaths);
  const lines = [
    "# After context reduction",
    `Earlier parts of this conversation were replaced with summaries (${SUMMARY_MESSAGE_OPEN}). ` +
      "The following is repeated once so that you can continue the work.",
    "",
    "## Files touched in the summarized part (newest first)",
  ];
  if (files.paths.length === 0) lines.push("- None");
  for (const p of files.paths) lines.push(`- ${p}`);
  if (files.omitted > 0) lines.push(`- (and ${files.omitted} more)`);
  lines.push("", "## Current work (from the summary)", summary.sections["Current work"]);
  return lines.join("\n");
}
