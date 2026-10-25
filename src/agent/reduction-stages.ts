/**
 * コンテキスト整理の決まった規則の段階 (docs/context-reduction-redesign.md §5.1〜§5.5。 整理の作り直し タスク 5)。
 *
 * 履歴の写し (MessageHistory.getRawMessages() の形。 固定の system は含まない) を受け取り、
 * 前処理 → 段階 0 → 段階 1 → 段階 2 を順に **最後まで** 当てはめた新しい写しと、 段階ごとの減った量・
 * 返した借りの件数・忘却の記録に入れる行を返す。 入力の配列もメッセージも書き換えない (純粋な関数)。
 * 変わらないメッセージは同じ参照のまま返し、 変えたものだけ新しいオブジェクトにする。
 *
 * ここでは履歴の差し替えも、 忘却の記録 (system ノート) の挿入もしない。 それは整理イベント (タスク 7) が、
 * 段階 3 (要約。 タスク 6) の後に 1 回だけ行う。
 *
 * 保護するもの (§5.1): system ノート (圧縮要約・忘却の記録)、 揮発でない利用者の発言、
 * 直近 K 回のツール呼び出し、 PROTECTED_TOOL_NAMES のツール、 ツールの対。
 * どの段階も system と user のメッセージの中身には触れない (前処理が終わった依頼の揮発メッセージを除くだけ)。
 */
import type { Message, ToolCall } from "../providers/base-provider.js";
import type { ReductionGoal } from "./context-budget.js";
import { findToolPairingError, toSentMessage } from "./message-history.js";
import { estimateMessageTokens, estimateTokens } from "./token-counter.js";

// ─── 目印と、 忘却の写しの書き方 ───

/** 本文を消したツール結果の目印 */
export const THINNED_MARKER = "[忘却済み]";

/**
 * tool_call 引数ではこれを超える文字列を「本文」 とみなし、 その呼び出しを対ごと履歴から外す
 * (docs/archive/context-forgetting.md §3.1)。 旧方式の切り詰め (先頭 N 文字を残す) の長さでもある
 */
export const THIN_TEXT_CHARS = 200;

/**
 * 本文とみなさない tool_call 引数。 「何に対して何をしたか」 の識別子なので、
 * 長くても呼び出しを残す理由になる (パスが長いだけの file_read を記録へ移さない)。
 */
const THIN_KEEP_ARG_KEYS = new Set(["file_path", "path", "url"]);

/** 忘却の記録に 1 行ずつ列挙する「呼び出しごと外した tool_call」 の上限 (超過分は件数で示す) */
export const REMOVED_CALLS_LISTED = 10;

export function contentToText(content: Message["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** 改行・連続空白を潰して 1 行に収める */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** ツール名を `名前×回数` に集計する */
export function summarizeToolNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()].map(([n, c]) => `${n}×${c}`).join(", ");
}

/** tool_call の引数から「何をしたか」 を 1 行で復元する (忘却の写しの本文・記録の行に使う) */
export function describeToolCall(name: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    for (const key of ["file_path", "path", "pattern", "command", "url", "query"]) {
      const v = args[key];
      if (typeof v === "string" && v.trim().length > 0) return `${name} ${oneLine(v, 80)}`;
    }
  } catch {
    // best-effort
  }
  return name;
}

/**
 * tool_call 引数に「本文」 (file_write の content、 file_edit の old/new 文字列、 長い bash の command など) が
 * 含まれるか。 書込系セッションではコンテキストの大半がここに乗り、 結果本文だけ落としても減らない
 * (2026-10-17 myppt セッションで未保護 158 セグメント中 80 が thin しても削減 0)。
 * 旧方式で切り詰め済みの引数 (`[忘却済み]` を含む) も本文ありとして扱い、 次の整理で記録へ移す。
 * 引数が JSON として読めないときは本文なしとして触らない (壊すと provider が 400 を返す)。
 */
export function hasBulkyArguments(argsJson: string): boolean {
  let args: unknown;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return false;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  return Object.entries(args as Record<string, unknown>).some(
    ([key, value]) =>
      typeof value === "string" &&
      !THIN_KEEP_ARG_KEYS.has(key) &&
      (value.length > THIN_TEXT_CHARS || value.includes(THINNED_MARKER)),
  );
}

/**
 * 既に本文を消した (または短くした) ツール結果か。 再変換しない (減らないうえ、 理由の行だけが積もる)。
 * 先頭が目印のもの (本文の差し替え) と、 途中の行が目印で始まるもの (段階 0-c の短縮・旧方式の切り詰め)。
 */
export function isForgottenText(text: string): boolean {
  return text.startsWith(THINNED_MARKER) || text.includes(`\n${THINNED_MARKER} `);
}

/** 本文を消したツール結果の差し替え先。 なぜ消したかで文末を変える */
export type ForgottenResultReason = "thin" | "reread" | "same-result";

const FORGOTTEN_RESULT_ENDING: Record<ForgottenResultReason, string> = {
  thin: "は履歴から削除しました。 必要なら再度実行して取得してください。",
  reread: "は後で読み直したため省略しました。",
  "same-result": "は後で同じ結果を得たため省略しました。",
};

export function forgottenResultText(call: ToolCall, resultText: string, reason: ForgottenResultReason): string {
  const tokens = estimateTokens(resultText);
  return (
    `${THINNED_MARKER} ${describeToolCall(call.function.name, call.function.arguments)} の結果 ` +
    `(約 ${tokens.toLocaleString("en-US")} トークン) ${FORGOTTEN_RESULT_ENDING[reason]}`
  );
}

/** 忘却の記録 (system ノート) の目印。 これで既存の記録を見つけて追記する */
export const TOMBSTONE_MARKER = "[忘却の記録]";

/**
 * 忘却の記録を写しに入れる (docs/archive/context-forgetting.md §4.4)。 既存の記録があればそこへ追記して 1 件にまとめ、
 * 無ければ「最初に忘却した位置」 に 1 件だけ挿入する (履歴中に散乱させない)。 入力の配列は書き換えない。
 */
export function insertTombstone(next: Message[], text: string, insertAt: number): Message[] {
  const existing = next.findIndex((m) => m.role === "system" && contentToText(m.content).startsWith(TOMBSTONE_MARKER));
  if (existing >= 0) {
    const merged = [...next];
    merged[existing] = {
      role: "system",
      content: `${contentToText(merged[existing].content)}\n\n${text}`,
    };
    return merged;
  }
  const at = Math.max(0, Math.min(insertAt, next.length));
  return [...next.slice(0, at), { role: "system", content: text }, ...next.slice(at)];
}

/** 呼び出しと結果の対ごと外したときの、 忘却の記録の 1 行 */
export function describeRemovedCall(call: ToolCall, result: Message | undefined): string {
  const argTokens = estimateTokens(call.function.arguments);
  const resultTokens = result ? estimateTokens(contentToText(result.content)) : 0;
  return (
    `${describeToolCall(call.function.name, call.function.arguments)} ` +
    `(引数 約 ${argTokens.toLocaleString("en-US")} / 結果 約 ${resultTokens.toLocaleString("en-US")} トークン)`
  );
}

/** 1 つの tool_call に対する変換 */
export type ToolCallAction = { kind: "remove" } | { kind: "replace-result"; content: string };

/**
 * 1 回の応答の組 (assistant(tool_calls) + 続く tool 結果) に、 呼び出しごとの変換を当てはめる (元は変更しない)。
 *   - remove: 呼び出しと結果の対ごと外す。 引数を切り詰めて呼び出しの形のまま残すことはしない
 *     (モデルが真似して壊れた呼び出しを出す。 docs/archive/context-forgetting.md §3.1 の 2026-10-18〜19 の実害)。
 *     呼び出しが 1 つも残らないときは本文 (か思考) だけの assistant にし、 どちらも無ければ消す。
 *   - replace-result: 結果の本文だけ差し替える。 呼び出しは残す (「このファイルを読んだ」 という行動の記録を
 *     消すと読み直しの繰り返しを招く)。 状態通知 (contextNote) などの他の欄は残す。
 * 変換の無い呼び出し・結果はそのまま (同じ参照) 返す。
 */
export function transformToolBatch(slice: readonly Message[], actions: ReadonlyMap<string, ToolCallAction>): Message[] {
  const head = slice[0];
  const calls = head.tool_calls ?? [];
  const keptCalls = calls.filter((c) => actions.get(c.id)?.kind !== "remove");
  const out: Message[] = [];
  if (keptCalls.length === calls.length) {
    out.push(head);
  } else if (keptCalls.length > 0) {
    out.push({ ...head, tool_calls: keptCalls });
  } else {
    const { tool_calls: _removed, ...rest } = head;
    if (contentToText(head.content).trim().length > 0 || head.thinking) out.push(rest);
  }
  for (const m of slice.slice(1)) {
    const action = m.tool_call_id ? actions.get(m.tool_call_id) : undefined;
    if (action?.kind === "remove") continue;
    if (action?.kind === "replace-result") {
      out.push({ ...m, content: action.content });
      continue;
    }
    out.push(m);
  }
  return out;
}

// ─── 保護するツール (§5.1) ───

/**
 * 結果に利用者の言葉や状態を持つツール。 どの段階でも呼び出しも結果も触らない。
 * ask_user (利用者の回答)、 ToDo の 3 つ (ToDo の状態)、 プランモードの出入り (承認の結果・計画の本文)、
 * response_complete (応答の終わりの記録)。 一覧は src/tools/definitions/ のツール名で確かめた (2026-10-25)。
 */
export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ask_user",
  "todo_append",
  "todo_mark",
  "todo_delete",
  "enter_plan_mode",
  "exit_plan_mode",
  "response_complete",
]);

/** 段階 2 で残す、 今の依頼の思考の件数 (§5.5) */
export const KEEP_RECENT_THINKING = 3;

/** 段階 0-c で残す、 失敗の結果の先頭の文字数 */
export const FAILED_RESULT_HEAD_CHARS = 300;

/** file_read の既定の範囲 (src/tools/definitions/file-read.ts と同じ) */
const FILE_READ_DEFAULT_OFFSET = 1;
const FILE_READ_DEFAULT_LIMIT = 2000;

// ─── 入出力 ───

export interface ReductionStagesInput {
  /** 履歴の写し (getRawMessages() の形)。 変更しない */
  messages: readonly Message[];
  /**
   * 今の依頼が始まる位置 (messages の添字)。 これより前が終わった依頼。
   * 依頼の終わりで整理するときは messages.length (全部が終わった依頼) を渡す。
   */
  currentRequestStart: number;
  /** K: 必ず残す直近のツール呼び出しの回数 (TIER_CONTEXT_BUDGETS[tier].keepRecentToolUses) */
  keepRecentToolUses: number;
  /** 整理前の P (measurePromptSize の値。 実数でも推定でもよい) */
  promptTokens: number;
  /** computeReductionGoal() の目標と最低量。 段階 3 が要るかの判定に使う */
  goal: ReductionGoal;
  /** パスの大小文字と区切り (\ と /) を区別しない。 省略時は Windows なら true */
  caseInsensitivePaths?: boolean;
}

export type ForgottenRule =
  | "0-a" // 後で読み直した file_read
  | "0-b" // 後で同じ結果を得た呼び出し
  | "0-c" // 後で成功した失敗
  | "0-d" // 後で上書きした file_write
  | "1-result" // 段階 1: 結果の本文を消した
  | "1-pair"; // 段階 1: 本文ありの呼び出しを対ごと外した

export interface ForgottenItem {
  rule: ForgottenRule;
  toolName: string;
  toolCallId: string;
  /** 忘却の記録に出す、 何をした呼び出しか */
  description: string;
  /** 送る形で減った推定トークン数 */
  freedTokens: number;
}

export interface ReductionStagesResult {
  /** 変換後の写し。 ツールの対の検証を通っている */
  messages: Message[];
  /**
   * 写しの各メッセージが元の履歴 (入力の messages) の何番目から来たか (messages と同じ長さ・昇順)。
   * 段階 3 (reduction-summary.ts) が写しで決めた範囲を、 サーバに送る元の履歴の位置に対応させるのに使う
   */
  originalIndices: number[];
  /** 段階ごとの減った量 (送る形 = 思考の inline 化を含む estimateMessageTokens の差) */
  freedTokens: { preprocess: number; stage0: number; stage1: number; stage2: number; total: number };
  /** 前処理で返した借り (§5.2): 除いた揮発メッセージと、 消した終わった依頼の思考の件数 */
  repaid: { ephemeral: number; thinking: number };
  /** 段階 2 で消した今の依頼の思考の件数 */
  clearedCurrentThinking: number;
  /** 段階 0・1 で消したもの (古い順) */
  forgotten: ForgottenItem[];
  /** 忘却の記録 (system ノート) に入れる行。 消したものが無ければ空 */
  recordLines: string[];
  /**
   * 最初に消したものの位置 (変換後の写しの添字)。 忘却の記録を元の時系列の位置に置くのに使う
   * (docs/archive/context-forgetting.md §4.4)。 何も消していなければ null
   */
  firstForgottenIndex: number | null;
  /** 段階 2 の後の推定 P (= 整理前の P − 減った量の合計) */
  promptTokensAfter: number;
  /** 段階 3 (要約) が要るか: 目標を超えている、 または最低量に届いていない */
  needsSummary: boolean;
  /** 目標まで足りない量と、 最低量まで足りない量 (どちらも 0 以上) */
  shortfall: { toTarget: number; toMinimum: number };
}

// ─── 本体 ───

interface Entry {
  message: Message;
  /** 入力での添字 */
  orig: number;
  /** 今の依頼の中か */
  current: boolean;
}

/** 送る形 (思考の inline 化・状態通知の連結) での推定トークン数 */
export function estimateSentMessageTokens(messages: readonly Message[]): number {
  return estimateMessageTokens(messages.map(toSentMessage));
}

function sizeOf(entries: readonly Entry[]): number {
  return estimateSentMessageTokens(entries.map((e) => e.message));
}

export function applyReductionStages(input: ReductionStagesInput): ReductionStagesResult {
  const caseInsensitive = input.caseInsensitivePaths ?? process.platform === "win32";
  const initial: Entry[] = input.messages.map((message, orig) => ({
    message,
    orig,
    current: orig >= input.currentRequestStart,
  }));
  const sizeBefore = sizeOf(initial);

  // 前処理 (§5.2): 終わった依頼の揮発メッセージを除き、 終わった依頼の思考を消す
  let repaidEphemeral = 0;
  let repaidThinking = 0;
  const pre: Entry[] = [];
  for (const e of initial) {
    if (e.current) {
      pre.push(e);
      continue;
    }
    // 揮発の印 (Message.ephemeral) は、 ハーネスが入れた促し・点検の催促など。 表示済みの応答には付かない
    if (e.message.ephemeral === true) {
      repaidEphemeral++;
      continue;
    }
    if (e.message.role === "assistant" && e.message.thinking) {
      repaidThinking++;
      pre.push({ ...e, message: withoutThinking(e.message) });
      continue;
    }
    pre.push(e);
  }
  const sizePre = sizeOf(pre);

  const forgotten: Array<ForgottenItem & { orig: number }> = [];
  const calls = collectCalls(pre, input.keepRecentToolUses);

  // 段階 0 (§5.3)
  const stage0Actions = new Map<string, ToolCallAction>();
  for (const call of calls) {
    if (call.protected) continue;
    const decided = decideStage0(call, calls, caseInsensitive);
    if (!decided) continue;
    const freed = actionGain(call, decided.action);
    if (freed <= 0) continue;
    stage0Actions.set(call.id, decided.action);
    forgotten.push({
      rule: decided.rule,
      toolName: call.name,
      toolCallId: call.id,
      description:
        decided.action.kind === "remove"
          ? describeRemovedCall(call.call, call.resultMessage)
          : describeToolCall(call.name, call.call.function.arguments),
      freedTokens: freed,
      orig: call.headOrig,
    });
  }
  const s0 = applyActions(pre, stage0Actions);
  const size0 = sizeOf(s0);

  // 段階 1 (§5.4): 保護されていない呼び出しの結果の本文を消す。 本文ありの呼び出しは対ごと外す
  const stage1Actions = new Map<string, ToolCallAction>();
  for (const call of collectCalls(s0, input.keepRecentToolUses)) {
    if (call.protected) continue;
    const action: ToolCallAction | null = hasBulkyArguments(call.call.function.arguments)
      ? { kind: "remove" }
      : call.resultText === null || isForgottenText(call.resultText)
        ? null
        : { kind: "replace-result", content: forgottenResultText(call.call, call.resultText, "thin") };
    if (!action) continue;
    const freed = actionGain(call, action);
    if (freed <= 0) continue;
    stage1Actions.set(call.id, action);
    forgotten.push({
      rule: action.kind === "remove" ? "1-pair" : "1-result",
      toolName: call.name,
      toolCallId: call.id,
      description:
        action.kind === "remove"
          ? describeRemovedCall(call.call, call.resultMessage)
          : describeToolCall(call.name, call.call.function.arguments),
      freedTokens: freed,
      orig: call.headOrig,
    });
  }
  const s1 = applyActions(s0, stage1Actions);
  const size1 = sizeOf(s1);

  // 段階 2 (§5.5): 今の依頼の思考を古い順に消す。 直近 KEEP_RECENT_THINKING 件は残す
  const thinkingAt = s1.flatMap((e, i) =>
    e.current && e.message.role === "assistant" && e.message.thinking ? [i] : [],
  );
  const clearAt = new Set(thinkingAt.slice(0, Math.max(0, thinkingAt.length - KEEP_RECENT_THINKING)));
  const s2 = s1.map((e, i) => (clearAt.has(i) ? { ...e, message: withoutThinking(e.message) } : e));
  const size2 = sizeOf(s2);

  const messages = s2.map((e) => e.message);
  const pairingError = findToolPairingError(messages);
  if (pairingError) {
    // 段階は対を分けない作りなので、 ここに来たら作りの誤り。 壊れた写しは返さない
    throw new Error(`[reduction-stages] 変換後の写しのツールの対が壊れています: ${pairingError}`);
  }

  const freedTokens = {
    preprocess: sizeBefore - sizePre,
    stage0: sizePre - size0,
    stage1: size0 - size1,
    stage2: size1 - size2,
    total: sizeBefore - size2,
  };
  const promptTokensAfter = input.promptTokens - freedTokens.total;
  const toTarget = Math.max(0, promptTokensAfter - input.goal.targetPromptTokens);
  const toMinimum = Math.max(0, input.goal.minimumReductionTokens - freedTokens.total);

  const firstOrig = forgotten.length > 0 ? Math.min(...forgotten.map((f) => f.orig)) : null;
  const firstForgottenIndex = firstOrig === null ? null : s2.filter((e) => e.orig < firstOrig).length;

  return {
    messages,
    originalIndices: s2.map((e) => e.orig),
    freedTokens,
    repaid: { ephemeral: repaidEphemeral, thinking: repaidThinking },
    clearedCurrentThinking: clearAt.size,
    forgotten: forgotten.map(({ orig: _orig, ...item }) => item),
    recordLines: buildReductionRecordLines(forgotten, clearAt.size),
    firstForgottenIndex,
    promptTokensAfter,
    needsSummary: toTarget > 0 || toMinimum > 0,
    shortfall: { toTarget, toMinimum },
  };
}

function withoutThinking(m: Message): Message {
  const { thinking: _thinking, ...rest } = m;
  return rest;
}

// ─── ツール呼び出しの一覧 ───

type CallStatus = "success" | "error" | "unknown";

interface CallInfo {
  id: string;
  name: string;
  call: ToolCall;
  /** 引数 (JSON として読めなければ null。 そのときは比べない) */
  args: Record<string, unknown> | null;
  /** キーを並べ替えた引数の JSON (読めなければ null) */
  normalizedArgs: string | null;
  resultMessage: Message | undefined;
  /** 結果の本文 (文字列でなければ null。 そのときは判定しない) */
  resultText: string | null;
  status: CallStatus;
  /** 呼び出しの順 (古い順の通し番号) */
  seq: number;
  /** 応答の組の先頭 (assistant) の入力での添字。 忘却の記録はこの手前に置く (対の間に挟まない) */
  headOrig: number;
  protected: boolean;
}

/**
 * 写しのツール呼び出しを古い順に並べる。 保護 (§5.1) の判定もここで行う:
 * PROTECTED_TOOL_NAMES、 直近 K 回、 最新の 1 回分の応答の組 (§5.3。 K が 0 でも古い側として扱わない)、 結果の無い呼び出し。
 */
function collectCalls(entries: readonly Entry[], keepRecentToolUses: number): CallInfo[] {
  const out: CallInfo[] = [];
  let lastBatchStart = -1;
  for (let i = 0; i < entries.length; i++) {
    const head = entries[i].message;
    if (head.role !== "assistant" || !head.tool_calls || head.tool_calls.length === 0) continue;
    lastBatchStart = out.length;
    const results = new Map<string, Entry>();
    for (let j = i + 1; j < entries.length && entries[j].message.role === "tool"; j++) {
      const id = entries[j].message.tool_call_id;
      if (id) results.set(id, entries[j]);
    }
    for (const call of head.tool_calls) {
      const result = results.get(call.id);
      const resultText = result && typeof result.message.content === "string" ? result.message.content : null;
      const args = parseArgs(call.function.arguments);
      out.push({
        id: call.id,
        name: call.function.name,
        call,
        args,
        normalizedArgs: args ? stableStringify(args) : null,
        resultMessage: result?.message,
        resultText,
        status: statusOf(resultText),
        seq: out.length,
        headOrig: entries[i].orig,
        protected: PROTECTED_TOOL_NAMES.has(call.function.name) || !result,
      });
    }
  }
  const recentFrom = Math.min(
    lastBatchStart < 0 ? out.length : lastBatchStart,
    out.length - Math.max(0, keepRecentToolUses),
  );
  for (let k = Math.max(0, recentFrom); k < out.length; k++) out[k].protected = true;
  return out;
}

/**
 * 成功・失敗は結果本文の先頭 `Error: ` で判定する (agent-loop.ts が失敗の結果をこの形で入れる)。
 * 本文が文字列でないもの・既に本文を消したものは判定できないので unknown (触らない・手本にもしない)。
 */
function statusOf(text: string | null): CallStatus {
  if (text === null || isForgottenText(text)) return "unknown";
  return text.startsWith("Error: ") ? "error" : "success";
}

function parseArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(argsJson || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** キーを並べ替えた JSON (引数の比較用。 キーの順が違うだけの同じ引数を同じとみなす) */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function filePathOf(call: CallInfo, caseInsensitive: boolean): string | null {
  const p = call.args?.file_path;
  if (typeof p !== "string" || p.trim().length === 0) return null;
  return caseInsensitive ? p.replace(/\\/g, "/").toLowerCase() : p;
}

/** file_read の範囲 [開始, 終わり)。 offset / limit が数でなければ null (判定しない) */
function readRangeOf(call: CallInfo): [number, number] | null {
  const offset = call.args?.offset ?? FILE_READ_DEFAULT_OFFSET;
  const limit = call.args?.limit ?? FILE_READ_DEFAULT_LIMIT;
  if (typeof offset !== "number" || typeof limit !== "number") return null;
  return [offset, offset + limit];
}

/** 段階 0-c の「同じ対象」: file_edit / file_write / file_read はパス、 bash はコマンド、 ほかは引数の全体 */
function targetOf(call: CallInfo, caseInsensitive: boolean): string | null {
  if (call.name === "file_edit" || call.name === "file_write" || call.name === "file_read") {
    return filePathOf(call, caseInsensitive);
  }
  if (call.name === "bash") {
    const c = call.args?.command;
    return typeof c === "string" ? c : null;
  }
  return call.normalizedArgs;
}

/**
 * 段階 0 の規則を 0-d → 0-a → 0-b → 0-c の順に当てはめる (1 つの呼び出しに 1 つだけ)。
 * 引数に本文を持つ呼び出しは 0-d 以外の対象にしない (段階 1 が対ごと外すので、 結果だけ差し替えても意味がない)。
 */
function decideStage0(
  t: CallInfo,
  calls: readonly CallInfo[],
  caseInsensitive: boolean,
): { rule: ForgottenRule; action: ToolCallAction } | null {
  if (t.status === "unknown" || t.resultText === null) return null;
  const later = calls.filter((u) => u.seq > t.seq);

  // 0-d 上書きされた書き込み
  if (t.name === "file_write") {
    const path = filePathOf(t, caseInsensitive);
    if (
      path !== null &&
      later.some((u) => u.name === "file_write" && u.status === "success" && filePathOf(u, caseInsensitive) === path)
    ) {
      return { rule: "0-d", action: { kind: "remove" } };
    }
  }
  if (hasBulkyArguments(t.call.function.arguments)) return null;

  // 0-a 読み直し (file_edit だけでは古いとみなさない。 編集の土台として要る)
  if (t.name === "file_read" && t.status === "success") {
    const path = filePathOf(t, caseInsensitive);
    const range = readRangeOf(t);
    if (path !== null && range !== null) {
      const superseded = later.some((u) => {
        if (u.status !== "success" || filePathOf(u, caseInsensitive) !== path) return false;
        if (u.name === "file_write") return true;
        if (u.name !== "file_read") return false;
        const r = readRangeOf(u);
        return r !== null && r[0] <= range[0] && r[1] >= range[1];
      });
      if (superseded) {
        return {
          rule: "0-a",
          action: { kind: "replace-result", content: forgottenResultText(t.call, t.resultText, "reread") },
        };
      }
    }
  }

  // 0-b 同じ結果
  if (
    t.normalizedArgs !== null &&
    later.some(
      (u) =>
        u.name === t.name &&
        u.status !== "unknown" &&
        u.normalizedArgs === t.normalizedArgs &&
        u.resultText === t.resultText,
    )
  ) {
    return {
      rule: "0-b",
      action: { kind: "replace-result", content: forgottenResultText(t.call, t.resultText, "same-result") },
    };
  }

  // 0-c 失敗のあとの成功 (何で失敗したかは先頭に残す)
  if (t.status === "error") {
    const target = targetOf(t, caseInsensitive);
    if (
      target !== null &&
      later.some((u) => u.name === t.name && u.status === "success" && targetOf(u, caseInsensitive) === target)
    ) {
      const head = t.resultText.slice(0, FAILED_RESULT_HEAD_CHARS);
      const dropped = estimateTokens(t.resultText.slice(FAILED_RESULT_HEAD_CHARS));
      return {
        rule: "0-c",
        action: {
          kind: "replace-result",
          content: `${head}\n${THINNED_MARKER} 以降 約 ${dropped.toLocaleString("en-US")} トークンは後で同じ対象に成功したため省略しました。`,
        },
      };
    }
  }
  return null;
}

/** 1 つの呼び出しに変換を当てはめたときに、 送る形で減る推定トークン数 */
function actionGain(call: CallInfo, action: ToolCallAction): number {
  const resultTokens = call.resultMessage ? estimateSentMessageTokens([call.resultMessage]) : 0;
  if (action.kind === "replace-result") {
    return resultTokens - estimateSentMessageTokens([{ ...(call.resultMessage as Message), content: action.content }]);
  }
  // 対を外すと、 呼び出しの分 (tool_calls の JSON) と結果の分が減る
  return estimateTokens(JSON.stringify([call.call])) + resultTokens;
}

/** 写しの応答の組ごとに変換を当てはめる。 添字 orig と今の依頼かどうかは元のメッセージのものを引き継ぐ */
function applyActions(entries: readonly Entry[], actions: ReadonlyMap<string, ToolCallAction>): Entry[] {
  if (actions.size === 0) return [...entries];
  const out: Entry[] = [];
  let i = 0;
  while (i < entries.length) {
    const head = entries[i];
    const calls = head.message.role === "assistant" ? (head.message.tool_calls ?? []) : [];
    if (calls.length === 0 || !calls.some((c) => actions.has(c.id))) {
      out.push(head);
      i++;
      continue;
    }
    let end = i + 1;
    while (end < entries.length && entries[end].message.role === "tool") end++;
    const slice = entries.slice(i, end);
    const transformed = transformToolBatch(
      slice.map((e) => e.message),
      actions,
    );
    // 変換後のメッセージを元の entry に対応づける (assistant は先頭、 tool は tool_call_id で)
    for (const m of transformed) {
      const from = m.role === "tool" ? (slice.find((e) => e.message.tool_call_id === m.tool_call_id) ?? head) : head;
      out.push({ message: m, orig: from.orig, current: from.current });
    }
    i = end;
  }
  return out;
}

// ─── 忘却の記録の行 ───

const RESULT_RULE_LABEL: Partial<Record<ForgottenRule, string>> = {
  "0-a": "後で読み直したため本文を省略",
  "0-b": "後で同じ結果を得たため本文を省略",
  "0-c": `失敗の結果を先頭 ${FAILED_RESULT_HEAD_CHARS} 字に短縮 (後で同じ対象に成功)`,
  "1-result": "本文のみ削除 (行動の記録は残存)",
};

/**
 * 忘却の記録に入れる行 (docs/archive/context-forgetting.md §4.4 の形)。 結果の本文を消したものは規則ごとにツール名と件数、
 * 対ごと外したものは 1 件 1 行 (REMOVED_CALLS_LISTED 件まで。 超えた分は件数で示し、 黙って欠けさせない)、
 * 段階 2 で消した思考は件数。 前処理 (揮発メッセージ・終わった依頼の思考) はハーネスの一時的なものなので行にせず、
 * 件数を repaid で返す (整理イベントの記録 §10.1 に出す)。
 */
export function buildReductionRecordLines(items: readonly ForgottenItem[], clearedCurrentThinking: number): string[] {
  const lines: string[] = [];
  for (const rule of ["0-a", "0-b", "0-c", "1-result"] as const) {
    const names = items.filter((f) => f.rule === rule).map((f) => f.toolName);
    if (names.length > 0) lines.push(`- ${RESULT_RULE_LABEL[rule]}: ${summarizeToolNames(names)}`);
  }
  const removed = items.filter((f) => f.rule === "0-d" || f.rule === "1-pair");
  if (removed.length > 0) {
    lines.push("- 実行済み (呼び出しと結果の本文は削除):");
    for (const r of removed.slice(0, REMOVED_CALLS_LISTED)) {
      lines.push(`  - ${r.description}${r.rule === "0-d" ? " (後で同じファイルに書き直し)" : ""}`);
    }
    if (removed.length > REMOVED_CALLS_LISTED) lines.push(`  - ほか ${removed.length - REMOVED_CALLS_LISTED} 件`);
  }
  if (clearedCurrentThinking > 0) lines.push(`- 今の依頼の古い思考: ${clearedCurrentThinking} 件を削除`);
  return lines;
}
