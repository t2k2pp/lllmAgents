/**
 * ツール結果を履歴に入れるときの上限 (docs/context-reduction-redesign.md §4.3。 整理の作り直し タスク 4)。
 *
 * - 1 件の上限: ティアの toolResultLimitTokens (トークン数。 切り詰めの注記を含む)。
 * - 同じ応答の合計の上限 T: ティアの toolResultTotalTokens。 1 回の応答で複数のツールを呼んだとき、
 *   結果を履歴に入れる順に数え、 残りの枠が 1 件の上限より小さければ残りの枠まで切る (後の結果ほど強く切られる)。
 *   ただし最低 MIN_TOOL_RESULT_TOKENS は残す。
 * - file_write / file_edit は切り詰めない (合計には数える)。
 *
 * 数え方は P の推定と同じ estimateTokens。 起動時検査 (checkContextWindowFits) の「K × 1 件の上限」 と
 * 実際の切り方が同じ数え方なので、 見積もりどおりに収まる。 切ったときは結果の中に注記を残す (黙って欠かさない)。
 */
import { estimateTokens } from "./token-counter.js";

/** 合計の上限に達した後も 1 件に残す最低量 (ASCII で約 930 字、 全角で約 230 字 ≒ 1KB 相当) */
export const MIN_TOOL_RESULT_TOKENS = 256;

/** 切り詰めないツール (書き込みの結果は短く、 何を書いたかの確認に要る。 合計には数える) */
export const UNTRUNCATED_TOOL_NAMES: ReadonlySet<string> = new Set(["file_write", "file_edit"]);

/** 残す本文のうち頭に回す割合 (残りは尻尾) */
const HEAD_SHARE = 2 / 3;

export type ToolResultTruncationReason = "per-result" | "response-total";

export interface ToolResultTruncation {
  reason: ToolResultTruncationReason;
  /** 切る前の推定トークン数 */
  originalTokens: number;
  /** 切った後の推定トークン数 (注記を含む) */
  keptTokens: number;
  /** この結果に許した量 */
  allowedTokens: number;
}

export interface ToolResultFit {
  content: string;
  /** 履歴に入れる内容の推定トークン数 */
  tokens: number;
  /** 切らなかったときは null */
  truncation: ToolResultTruncation | null;
}

export interface ToolResultLimits {
  /** 1 件の上限 (ティアの toolResultLimitTokens) */
  perResultTokens: number;
  /** 同じ応答の合計の上限 T (ティアの toolResultTotalTokens) */
  totalTokens: number;
}

/**
 * 1 回の応答 (= 1 回の本体呼び出しが返したツール呼び出しの組) の結果の合計を数える。
 * 応答ごとに新しく作り、 結果を履歴に入れる直前に fit() を通す。 並列に実行しても、
 * fit() を呼ぶ順 (= 履歴に入れる順) で数えるので結果は決定的になる。
 */
export class ToolResultBatch {
  private used = 0;

  constructor(private readonly limits: ToolResultLimits) {}

  /** これまでに入れた結果の推定トークン数の合計 */
  get usedTokens(): number {
    return this.used;
  }

  fit(toolName: string, content: string): ToolResultFit {
    const tokens = estimateTokens(content);
    if (UNTRUNCATED_TOOL_NAMES.has(toolName)) {
      this.used += tokens;
      return { content, tokens, truncation: null };
    }
    const remaining = this.limits.totalTokens - this.used;
    const allowedTokens = Math.min(this.limits.perResultTokens, Math.max(MIN_TOOL_RESULT_TOKENS, remaining));
    if (tokens <= allowedTokens) {
      this.used += tokens;
      return { content, tokens, truncation: null };
    }
    const reason: ToolResultTruncationReason =
      allowedTokens < this.limits.perResultTokens ? "response-total" : "per-result";
    const cut = truncateToolResultToTokens(toolName, content, allowedTokens, {
      reason,
      totalTokens: this.limits.totalTokens,
    });
    const keptTokens = estimateTokens(cut);
    this.used += keptTokens;
    return {
      content: cut,
      tokens: keptTokens,
      truncation: { reason, originalTokens: tokens, keptTokens, allowedTokens },
    };
  }
}

/**
 * 頭と尻尾を残して中央を切り、 結果の推定トークン数 (注記を含む) を limitTokens 以下にする。
 * 中央には何をどれだけ切ったか、 なぜ切ったかの注記を入れる (モデル向けなので英語)。
 */
export function truncateToolResultToTokens(
  toolName: string,
  content: string,
  limitTokens: number,
  why: { reason: ToolResultTruncationReason; totalTokens: number },
): string {
  const originalTokens = estimateTokens(content);
  if (originalTokens <= limitTokens) return content;
  const chars = Array.from(content);
  // 注記の長さは数字の桁で変わるので、 最も長くなる数字 (全部切った場合) で枠を見積もってから切る
  const noteBudget = estimateTokens(buildNote(toolName, chars.length, chars.length, originalTokens, limitTokens, why));
  const bodyTokens = Math.max(0, limitTokens - noteBudget);
  const headTokens = Math.floor(bodyTokens * HEAD_SHARE);
  const tailTokens = bodyTokens - headTokens;
  const headEnd = countFromHead(chars, headTokens);
  const tailStart = Math.max(headEnd, chars.length - countFromTail(chars, tailTokens));
  const head = chars.slice(0, headEnd).join("");
  const tail = chars.slice(tailStart).join("");
  const removedChars = tailStart - headEnd;
  const note = buildNote(toolName, removedChars, chars.length, originalTokens, limitTokens, why);
  return head + note + tail;
}

function buildNote(
  toolName: string,
  removedChars: number,
  totalChars: number,
  originalTokens: number,
  limitTokens: number,
  why: { reason: ToolResultTruncationReason; totalTokens: number },
): string {
  const reasonText =
    why.reason === "response-total"
      ? `the tool results of this response reached their combined limit of ${why.totalTokens} tokens, so this result was cut to ${limitTokens} tokens`
      : `the limit for one tool result is ${limitTokens} tokens`;
  return (
    `\n\n...[truncated by the harness: ${removedChars} of ${totalChars} characters were removed from the middle of the ` +
    `"${toolName}" result (about ${originalTokens} tokens in full); ${reasonText}. ` +
    `If you need the removed part, read it in smaller pieces (offset/limit, grep, head/tail).]...\n\n`
  );
}

/** 1 文字の推定コスト (estimateTokens の 1.1 倍する前の値) */
function charCost(char: string): number {
  return (char.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.25;
}

/** 先頭から、 estimateTokens が tokens を超えない最大の文字数 */
function countFromHead(chars: readonly string[], tokens: number): number {
  let raw = 0;
  let n = 0;
  for (const c of chars) {
    const next = raw + charCost(c);
    if (Math.ceil(next * 1.1) > tokens) break;
    raw = next;
    n++;
  }
  return n;
}

/** 末尾から、 estimateTokens が tokens を超えない最大の文字数 */
function countFromTail(chars: readonly string[], tokens: number): number {
  let raw = 0;
  let n = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const next = raw + charCost(chars[i]);
    if (Math.ceil(next * 1.1) > tokens) break;
    raw = next;
    n++;
  }
  return n;
}
