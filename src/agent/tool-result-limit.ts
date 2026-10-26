/**
 * ツール結果を履歴に入れるときの上限 (docs/context-reduction-redesign.md §4.3。 整理の作り直し タスク 4、 2026-10-26 改訂)。
 *
 * - 1 件の上限: ティアの toolResultLimitTokens (トークン数。 切り詰めの注記を含む)。
 * - 同じ応答の合計の上限 T: ティアの toolResultTotalTokens。 1 回の応答 (1 回の本体呼び出しが返したツール呼び出しの組) の
 *   結果を、 履歴に入れる順に数える。 数えるのは結果のメッセージの推定 (本文 + 1 件の枠 MESSAGE_OVERHEAD_TOKENS。
 *   P の推定 estimateMessageTokens と同じ数え方)。 **合計は必ず T 以下に収める** (注記を含めて)。
 *   - 応答の呼び出しの総数が分かっているので、 まだ入れていない呼び出しの分の「本文を省いた注記」 をあらかじめ残しておき、
 *     その残りで本文を入れる。 残りが 1 件の上限より小さければ残りまで切り (後の結果ほど強く切られる)、
 *     残りが最低量 MIN_TOOL_RESULT_TOKENS にも届かなければ本文を入れず、 注記だけにする (省いた呼び出しも実行は済んでいる)。
 *   - 注記は 2 つの大きさ: 最初に省いた結果には、 何が起きたかと次にどうすればよいかを書いた長い注記 (英語) を入れる
 *     (この分は 1 件目を省くまで残しておく)。 それ以降は、 余裕があれば長い注記、 なければ短い注記 (成否だけ)。
 *   - 短い注記は通常 `[omitted; ok]` / `Error: [omitted]`。 呼び出しが極端に多く、 それでも合計が T を超えうる応答
 *     (出力上限 O の中で出せる呼び出しの最大の近く) では、 さらに短い `ok` / `Error: ` にする。 それでも入らない
 *     (作りの上では起きない) ときは `overflow` を立て、 呼び出し側が利用者に赤字で知らせる (ツールの対は必ず保つ)。
 * - file_write / file_edit は切り詰めない。 残りに入らないときは本文を注記にする (成否は注記に必ず残す)。
 * - 失敗の結果 (先頭 `Error: `) の注記は `Error: ` で始める (段階 0 の成否の判定と同じ形)。
 *
 * 数え方は P の推定と同じ estimateTokens。 起動時検査 (checkContextWindowFits) の「K × 1 件の上限」 と
 * 実際の切り方が同じ数え方なので、 見積もりどおりに収まる。 切ったときは結果の中に注記を残す (黙って欠かさない)。
 */
import { estimateTokens, MESSAGE_OVERHEAD_TOKENS } from "./token-counter.js";

/** 合計の上限の中で、 本文を (切ってでも) 入れる最低量 (ASCII で約 930 字、 全角で約 230 字 ≒ 1KB 相当) */
export const MIN_TOOL_RESULT_TOKENS = 256;

/** 切り詰めないツール (書き込みの結果は短く、 何を書いたかの確認に要る。 合計には数える) */
export const UNTRUNCATED_TOOL_NAMES: ReadonlySet<string> = new Set(["file_write", "file_edit"]);

/** 残す本文のうち頭に回す割合 (残りは尻尾) */
const HEAD_SHARE = 2 / 3;

/**
 * 本文を省いた結果の短い注記。 上から順に、 応答の呼び出しの全部に使っても合計が T に収まる最初のものを使う。
 * 2 つ目は呼び出しが極端に多い応答だけ (docs/context-reduction-redesign.md §4.3 の計算)。
 */
export const BRIEF_OMISSION_NOTES: ReadonlyArray<{ ok: string; failed: string }> = [
  { ok: "[omitted; ok]", failed: "Error: [omitted]" },
  { ok: "ok", failed: "Error: " },
];

export type ToolResultTruncationReason = "per-result" | "response-total" | "omitted";

export interface ToolResultTruncation {
  /** per-result: 1 件の上限で切った / response-total: 合計の残りで切った / omitted: 本文を入れず注記だけにした */
  reason: ToolResultTruncationReason;
  /** 切る前の推定トークン数 */
  originalTokens: number;
  /** 切った後の推定トークン数 (注記を含む) */
  keptTokens: number;
  /** この結果の本文に許した量 (omitted では本文を入れられなかった残り) */
  allowedTokens: number;
}

export interface ToolResultFit {
  content: string;
  /** 履歴に入れる内容の推定トークン数 (本文だけ。 合計にはこれに 1 件の枠を足して数える) */
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

/** 1 回の応答の結果を入れ終えたときのまとめ (利用者向けの 1 行に使う) */
export interface ToolResultBatchSummary {
  callCount: number;
  totalTokens: number;
  /** 入れた結果の推定の合計 (本文 + 1 件の枠) */
  usedTokens: number;
  /** 合計の残りで切った件数 */
  truncatedByTotal: number;
  /** 本文を省いて注記だけにした呼び出しのツール名 (入れた順) */
  omitted: string[];
  /** 注記だけでも合計が T を超える (作りの上では起きない)。 呼び出し側が利用者に知らせる */
  overflow: boolean;
}

/**
 * 1 回の応答 (= 1 回の本体呼び出しが返したツール呼び出しの組) の結果の合計を数える。
 * 応答ごとに、 その応答の呼び出しのツール名 (入れる順) を渡して新しく作り、 結果を履歴に入れる直前に fit() を通す。
 * 並列に実行しても、 fit() を呼ぶ順 (= 履歴に入れる順) で数えるので結果は決定的になる。
 * 呼び出しの数より多く fit() を呼ぶのは作りの誤りなので例外にする (残しておく分の計算が崩れるため)。
 */
export class ToolResultBatch {
  private used = 0;
  private index = 0;
  private fullNoteUsed = false;
  private truncatedByTotal = 0;
  private readonly omitted: string[] = [];
  private readonly brief: { ok: string; failed: string };
  /** 短い注記 1 件の大きさ (枠を含む。 成功・失敗の大きい方) */
  private readonly briefCost: number;
  /** 長い注記 1 件の大きさ (枠を含む。 この応答のツール名と成否の中で最も長いもの) */
  private readonly fullCost: number;
  readonly overflow: boolean;

  constructor(
    private readonly limits: ToolResultLimits,
    private readonly toolNames: readonly string[],
  ) {
    const names = toolNames.length > 0 ? [...new Set(toolNames)] : [""];
    this.fullCost = Math.max(
      ...names.flatMap((n) =>
        [true, false].map((failed) =>
          messageCost(fullOmissionNote(n, failed, limits.totalTokens, BRIEF_OMISSION_NOTES[0])),
        ),
      ),
      ...names.flatMap((n) =>
        [true, false].map((failed) =>
          messageCost(fullOmissionNote(n, failed, limits.totalTokens, BRIEF_OMISSION_NOTES[1])),
        ),
      ),
    );
    const fits = (b: { ok: string; failed: string }) =>
      reserveFor(toolNames.length, false, this.fullCost, briefCostOf(b)) <= limits.totalTokens;
    const chosen = BRIEF_OMISSION_NOTES.find(fits);
    this.brief = chosen ?? BRIEF_OMISSION_NOTES[BRIEF_OMISSION_NOTES.length - 1];
    this.briefCost = briefCostOf(this.brief);
    this.overflow = chosen === undefined;
  }

  /** これまでに入れた結果の推定トークン数の合計 (本文 + 1 件の枠) */
  get usedTokens(): number {
    return this.used;
  }

  fit(toolName: string, content: string): ToolResultFit {
    if (this.index >= this.toolNames.length) {
      throw new Error(
        `[tool-result-limit] 応答の呼び出しの数 (${this.toolNames.length}) より多くの結果を入れようとしました (${toolName})`,
      );
    }
    const remainingAfter = this.toolNames.length - this.index - 1;
    this.index++;
    const tokens = estimateTokens(content);
    // この結果に使える量 = 合計の残り − まだ入れていない呼び出しの注記の分 (枠を含む)
    const room = this.limits.totalTokens - this.used - this.reserve(remainingAfter);
    const bodyRoom = room - MESSAGE_OVERHEAD_TOKENS;

    if (UNTRUNCATED_TOOL_NAMES.has(toolName)) {
      if (tokens <= bodyRoom) return this.accept(content, tokens, null);
      return this.omit(toolName, content, tokens, Math.max(0, bodyRoom), remainingAfter);
    }
    const allowedTokens = Math.min(this.limits.perResultTokens, bodyRoom);
    if (tokens <= allowedTokens) return this.accept(content, tokens, null);
    if (allowedTokens < MIN_TOOL_RESULT_TOKENS) {
      return this.omit(toolName, content, tokens, Math.max(0, bodyRoom), remainingAfter);
    }
    const reason: ToolResultTruncationReason =
      allowedTokens < this.limits.perResultTokens ? "response-total" : "per-result";
    const cut = truncateToolResultToTokens(toolName, content, allowedTokens, {
      reason,
      totalTokens: this.limits.totalTokens,
    });
    const keptTokens = estimateTokens(cut);
    if (reason === "response-total") this.truncatedByTotal++;
    return this.accept(cut, keptTokens, { reason, originalTokens: tokens, keptTokens, allowedTokens });
  }

  summary(): ToolResultBatchSummary {
    return {
      callCount: this.toolNames.length,
      totalTokens: this.limits.totalTokens,
      usedTokens: this.used,
      truncatedByTotal: this.truncatedByTotal,
      omitted: [...this.omitted],
      overflow: this.overflow,
    };
  }

  /** まだ入れていない count 件の呼び出しの注記の分 (長い注記を 1 件目に使うまでは、 その 1 件を長い注記で数える) */
  private reserve(count: number): number {
    return reserveFor(count, this.fullNoteUsed, this.fullCost, this.briefCost);
  }

  private accept(content: string, tokens: number, truncation: ToolResultTruncation | null): ToolResultFit {
    this.used += tokens + MESSAGE_OVERHEAD_TOKENS;
    return { content, tokens, truncation };
  }

  /**
   * 本文を入れず注記だけにする。 1 件目は必ず長い注記 (その分は残してある)。 それ以降は、 残りの呼び出しの短い注記の分を
   * 引いても入るなら長い注記、 入らなければ短い注記。 成否 (先頭 `Error: `) は注記に残す。
   */
  private omit(
    toolName: string,
    content: string,
    tokens: number,
    allowedTokens: number,
    remainingAfter: number,
  ): ToolResultFit {
    const failed = content.startsWith("Error: ");
    const full = fullOmissionNote(toolName, failed, this.limits.totalTokens, this.brief);
    const fullFits =
      !this.fullNoteUsed || this.limits.totalTokens - this.used - messageCost(full) >= remainingAfter * this.briefCost;
    const note = fullFits ? full : failed ? this.brief.failed : this.brief.ok;
    this.fullNoteUsed = true;
    this.omitted.push(toolName);
    const keptTokens = estimateTokens(note);
    return this.accept(note, keptTokens, { reason: "omitted", originalTokens: tokens, keptTokens, allowedTokens });
  }
}

/** count 件の注記の分。 長い注記をまだ使っていなければ、 そのうち 1 件を長い注記で数える */
function reserveFor(count: number, fullNoteUsed: boolean, fullCost: number, briefCost: number): number {
  if (count <= 0) return 0;
  return fullNoteUsed ? count * briefCost : fullCost + (count - 1) * briefCost;
}

function messageCost(content: string): number {
  return estimateTokens(content) + MESSAGE_OVERHEAD_TOKENS;
}

function briefCostOf(b: { ok: string; failed: string }): number {
  return Math.max(messageCost(b.ok), messageCost(b.failed));
}

/**
 * 本文を省いた結果の長い注記 (モデル向けなので英語)。 何が起きたか (呼び出しは済んでいて、 結果が成功か失敗かを伝えたか)、
 * 後の短い注記の読み方、 次にどうすればよいか (後の応答で取り直す。 変更を伴う呼び出しは繰り返さない) を書く。
 */
export function fullOmissionNote(
  toolName: string,
  failed: boolean,
  totalTokens: number,
  brief: { ok: string; failed: string },
): string {
  return (
    `${failed ? "Error: " : ""}[Result omitted by the harness: the "${toolName}" call was handled and its result reported ` +
    `${failed ? "an error" : "success"}, but the result text is not shown because the tool results of this response ` +
    `reached their combined limit of ${totalTokens} tokens. Other results omitted for the same reason are shown only as ` +
    `"${brief.ok}" (success) or "${brief.failed.trim()}" (error). If you still need a result, get it again in a later ` +
    `response with fewer tool calls per response. Do not repeat calls that change files or state.]`
  );
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
