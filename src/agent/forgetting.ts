/**
 * Selective Forgetting — 忘却によるコンテキスト縮約
 *
 * 圧縮 (HierarchicalCompressor) が「古いものを一律に要約する」 のに対し、
 * 忘却は「何を覚え、 何を忘れるか」 をモデル自身に選ばせる。
 *   - 残すものは原文のまま無劣化
 *   - 捨てるものは完全に捨てる (中途半端な要約を残さない)
 *   - 捨てた事実は必ずトゥームストーンに残す (silent な欠損は禁止)
 *
 * 忘却の単位は「メッセージ」 ではなく「セグメント」。 OpenAI 互換 API では
 * tool_calls を持つ assistant と対応する role="tool" が必ずペアで存在する必要があり、
 * メッセージ単位で消すとペアが分断されて 400 になるため。
 *
 * docs/context-forgetting.md が正本。
 */
import type { LLMProvider, Message } from "../providers/base-provider.js";
import { isRateLimitError } from "../providers/utils/rate-limit.js";
import { collectResponse } from "../providers/base-provider.js";
import { estimateTokens, estimateMessageTokens } from "./token-counter.js";
import type { MessageHistory } from "./message-history.js";
import * as logger from "../utils/logger.js";
import { sideCall } from "./side-call.js";
import {
  REMOVED_CALLS_LISTED,
  TOMBSTONE_MARKER,
  THIN_TEXT_CHARS,
  THINNED_MARKER,
  type ToolCallAction,
  contentToText,
  describeRemovedCall,
  forgottenResultText,
  hasBulkyArguments,
  insertTombstone,
  oneLine,
  summarizeToolNames,
  transformToolBatch,
} from "./reduction-stages.js";

// ─── 定数 ───

/** 忘却選択の LLM 呼び出しのサンプリング設定。 分類タスクなので決定論寄りに倒す */
const FORGET_TEMPERATURE = 0.1;
/** 思考モデルの最小思考 (100〜300t) + 忘却 JSON (100〜500t) を収める適正上限 */
const FORGET_MAX_TOKENS = 1500;

/** 直近何セグメントを保護するか (既定) */
export const DEFAULT_KEEP_RECENT_SEGMENTS = 6;

/** digest に載せる本文の文字数 (マニフェスト 1 行に収める) */
const DIGEST_CHARS = 60;

// ─── 型 ───

export type SegmentKind = "user" | "assistant_text" | "tool_batch" | "system_note";

export interface Segment {
  /** 履歴内の 1 始まり通し番号。 モデルはこの番号で忘却対象を指す */
  index: number;
  kind: SegmentKind;
  /** このセグメントに含まれる messages の [開始, 終了) */
  range: [number, number];
  /** 推定トークン数 (drop したときに減る量) */
  tokens: number;
  /**
   * thin したときに実際に減る推定トークン数。
   * thin 済みのセグメントや短文は 0 になる。 total だけを見せるとモデルが
   * 「大きく見えるが thin しても 1 トークンも減らない」 セグメントを選び、
   * トゥームストーン分だけ増えて忘却が不成立になる (docs §3.1)
   */
  thinGain: number;
  /** 1 行ダイジェスト (manifest 表示用) */
  digest: string;
  /** tool_batch のときの内訳: 呼ばれたツール名 */
  toolNames?: string[];
  /** 保護されているか (直近 N セグメント / 忘却済みトゥームストーン) */
  protected: boolean;
}

/** モデルの選択を検証した後の、 実際に適用するプラン */
export interface ForgetPlan {
  segments: Segment[];
  /** thin するセグメント index (1 始まり) */
  thin: number[];
  /** drop するセグメント index (1 始まり) */
  drop: number[];
  /** モデルが述べた理由 */
  reason: string;
  /** 検証で弾いた内容 (ユーザーに提示して silent な破棄をしない) */
  warnings: string[];
  /** 目標削減トークン数 */
  targetTokens: number;
  /** 適用した場合に削減できる推定トークン数 */
  estimatedFreedTokens: number;
}

export interface ForgetResult {
  applied: boolean;
  /** 実削減トークン数 (適用前後の推定差) */
  freedTokens: number;
  thinnedSegments: number;
  droppedSegments: number;
  plan: ForgetPlan | null;
  /** 適用しなかった / できなかった理由 (applied=false のとき) */
  reason?: string;
}

/** /forget dry の結果。 適用せずに「何が消えるか」 を見せる */
export interface ForgetDryRunReport {
  manifest: string;
  plan: ForgetPlan | null;
  reason?: string;
}

// ─── セグメント化 ───

/**
 * パスを末尾優先で 1 行に収める。 先頭から切ると同じプロジェクト内のファイルが
 * `C:\Users\…\src\g…` のように全部同じ表示になり、 モデルが区別できない。
 */
function pathTail(path: string, max: number): string {
  const flat = path.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `…${flat.slice(flat.length - (max - 1))}`;
}

/** tool_calls の引数から代表的なパス等を 1 つ拾う (digest 用) */
function pickRepresentativeArg(msg: Message): string | undefined {
  const calls = msg.tool_calls ?? [];
  for (const c of calls) {
    try {
      const args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
      for (const key of ["file_path", "path", "pattern", "command", "url", "query"]) {
        const v = args[key];
        if (typeof v !== "string" || v.trim().length === 0) continue;
        return key === "file_path" || key === "path" ? pathTail(v, 40) : oneLine(v, 40);
      }
    } catch {
      // 引数が壊れていても digest は best-effort でよい
    }
  }
  return undefined;
}

/**
 * メッセージ列をセグメントに分割する。
 * tool_calls を持つ assistant と後続の tool 結果は 1 つの tool_batch に束ねられるため、
 * セグメント単位で消す限りペアの分断は構造的に起こり得ない。
 *
 * @param messages MessageHistory.getRawMessages() の結果 (system prompt を含まない生履歴)
 * @param keepRecentSegments 末尾から何セグメントを保護するか
 */
export function buildSegments(messages: Message[], keepRecentSegments = DEFAULT_KEEP_RECENT_SEGMENTS): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const start = i;

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // assistant(tool_calls) + 続く tool 結果すべて = 不可分な tool_batch
      let end = i + 1;
      while (end < messages.length && messages[end].role === "tool") end++;
      const names = msg.tool_calls.map((c) => c.function.name);
      const repr = pickRepresentativeArg(msg);
      segments.push({
        index: segments.length + 1,
        kind: "tool_batch",
        range: [start, end],
        tokens: estimateMessageTokens(messages.slice(start, end)),
        thinGain: 0,
        digest: summarizeToolNames(names) + (repr ? `  (${repr})` : ""),
        toolNames: names,
        protected: false,
      });
      i = end;
      continue;
    }

    if (msg.role === "tool") {
      // 対応する assistant を持たない孤立 tool 結果 (通常発生しない)。
      // 触ると壊す危険があるので単独セグメント + 常時保護にして忘却対象から外す。
      segments.push({
        index: segments.length + 1,
        kind: "system_note",
        range: [start, start + 1],
        tokens: estimateMessageTokens([msg]),
        thinGain: 0,
        digest: "(孤立した tool 結果 — 保護)",
        protected: true,
      });
      i++;
      continue;
    }

    const kind: SegmentKind = msg.role === "system" ? "system_note" : msg.role === "user" ? "user" : "assistant_text";
    segments.push({
      index: segments.length + 1,
      kind,
      range: [start, start + 1],
      tokens: estimateMessageTokens([msg]),
      thinGain: 0,
      digest: oneLine(contentToText(msg.content), DIGEST_CHARS),
      // 圧縮要約 / 忘却トゥームストーンの system は常に保護 (docs §2.2)
      protected: kind === "system_note",
    });
    i++;
  }

  for (const seg of segments) {
    const slice = messages.slice(seg.range[0], seg.range[1]);
    seg.thinGain = Math.max(0, seg.tokens - estimateMessageTokens(thinSlice(seg.kind, slice).messages));
  }

  // 直近 keepRecentSegments 個を保護する
  const from = Math.max(0, segments.length - Math.max(0, keepRecentSegments));
  for (let k = from; k < segments.length; k++) segments[k].protected = true;

  return segments;
}

// ─── マニフェスト ───

const KIND_LABEL: Record<SegmentKind, string> = {
  user: "user",
  assistant_text: "assistant",
  tool_batch: "tools",
  system_note: "note",
};

/** モデルに見せる 1 セグメント 1 行の一覧。 トークンを食わないよう極力コンパクトに */
export function buildManifest(segments: Segment[]): string {
  const lines: string[] = [];
  let protectedHeaderShown = false;
  for (const s of segments) {
    if (s.protected && !protectedHeaderShown) {
      // 保護区間は履歴末尾にまとまるので、 最初の 1 個の手前に区切りを 1 度だけ入れる
      lines.push("--- 以下は保護 (忘却対象外) ---");
      protectedHeaderShown = true;
    }
    const num = `#${s.index}`.padEnd(5);
    const kind = KIND_LABEL[s.kind].padEnd(10);
    const tok = `${s.tokens.toLocaleString("en-US")}t`.padStart(9);
    // drop で減る量 (total) と thin で減る量は別物。 thin 済みは thin しても減らないので明示する
    const thin = (s.thinGain > 0 ? `thin→${s.thinGain.toLocaleString("en-US")}t` : "thin済").padEnd(13);
    lines.push(`${num}${kind}${tok}  ${thin}${s.digest}`);
  }
  return lines.join("\n");
}

/** モデルへの指示文 (docs §4.2)。 keep は明示させず「挙げなかったものが keep」 とする */
export function buildForgetPrompt(manifest: string, targetTokens: number): string {
  return (
    `以下は現在の会話履歴の一覧です。 コンテキストが上限に近づいたため、\n` +
    `どれを残し、 どれを忘れるかを選んでください。\n\n` +
    `目標: 約 ${targetTokens.toLocaleString("en-US")} トークン削減\n\n` +
    `判断基準:\n` +
    `- keep: ユーザーの指示・制約、 未解決の判断、 いま進行中の作業に必要な情報\n` +
    `- thin: 行動の記録は要るが結果の本文はもう要らないもの (再度ツールを実行すれば取り直せる)\n` +
    `- drop: 用済みの探索、 失敗して捨てた試行、 現在の作業と無関係な話題\n\n` +
    `原則: 迷ったら thin を選ぶ。 drop はユーザー指示を含まないと確信できるものだけ。\n` +
    `keep は書かなくてよい (thin / drop に挙げなかったものは自動的に keep になる)。\n` +
    `「保護」 と書かれた行は選べません。\n` +
    `各行の数値は drop で減る量、 thin→Nt は thin で減る量です。 「thin済」 の行は thin しても減らないので thin に挙げないでください。\n\n` +
    `JSON のみを返してください:\n` +
    `{"thin": [2, 4], "drop": [], "reason": "巨大なソース読み込みの本文を落とした。 指示と判断は全て残した"}\n\n` +
    `【重要制約】これは機械的分類タスクです。内部思考（thinking）は最小限にとどめ、直ちに上記JSONのみを出力してください。\n\n` +
    `## 履歴一覧\n${manifest}\n`
  );
}

// ─── モデル出力のパース・検証 ───

export interface RawForgetChoice {
  thin: number[];
  drop: number[];
  reason: string;
}

function toIndexArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v.replace(/^#/, ""), 10) : NaN;
    if (Number.isInteger(n)) out.push(n);
  }
  return out;
}

/** LLM 応答から JSON を取り出す。 失敗したら null (呼び出し側が 1 回だけ再試行する) */
export function parseForgetResponse(raw: string): RawForgetChoice | null {
  // ```json フェンスや前置きテキストが付くモデルがあるので、 最外の {...} を拾う
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const thin = toIndexArray(parsed.thin);
    const drop = toIndexArray(parsed.drop);
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    return { thin, drop, reason };
  } catch {
    return null;
  }
}

/**
 * モデルの出力をそのまま信じない (docs §4.3)。
 *   - 存在しない index → 無視 (警告)
 *   - protected セグメント → 無視 (警告)
 *   - user セグメントの drop → thin に格下げ (ユーザーの言葉を完全消去させない)
 *   - drop と thin の両方に出た → drop を採用
 */
export function validateChoice(
  segments: Segment[],
  choice: RawForgetChoice,
): { thin: number[]; drop: number[]; warnings: string[] } {
  const byIndex = new Map(segments.map((s) => [s.index, s]));
  const warnings: string[] = [];
  const drop = new Set<number>();
  const thin = new Set<number>();

  const accept = (idx: number, action: "thin" | "drop"): void => {
    const seg = byIndex.get(idx);
    if (!seg) {
      warnings.push(`#${idx} は存在しないセグメントのため無視しました`);
      return;
    }
    if (seg.protected) {
      warnings.push(`#${idx} は保護セグメント (${KIND_LABEL[seg.kind]}) のため無視しました`);
      return;
    }
    if (action === "drop" && seg.kind === "user") {
      // ユーザーが言ったことが消えるのが最も回復不能な損失なので、 完全消去はさせない
      warnings.push(`#${idx} は user セグメントのため drop → thin に格下げしました`);
      action = "thin";
    }
    if (action === "thin" && seg.thinGain <= 0) {
      // thin 済み / 短文を thin しても 1 トークンも減らず、 トゥームストーン分だけ増える
      warnings.push(`#${idx} は thin しても削減できない (thin 済み・短文) ため無視しました`);
      return;
    }
    if (action === "drop") drop.add(idx);
    else thin.add(idx);
  };

  for (const idx of choice.drop) accept(idx, "drop");
  for (const idx of choice.thin) accept(idx, "thin");
  // drop が勝つ (両方に挙げられたら消す方を採る)
  for (const idx of drop) thin.delete(idx);

  return {
    thin: [...thin].sort((a, b) => a - b),
    drop: [...drop].sort((a, b) => a - b),
    warnings,
  };
}

// ─── 適用 ───

/**
 * プランを適用した新しいメッセージ列を作る (元配列は変更しない)。
 * 適用位置は範囲の重複が起きないよう segment.range をそのまま使う。
 */
export function applyPlanToMessages(
  messages: Message[],
  segments: Segment[],
  thin: number[],
  drop: number[],
): { next: Message[]; thinnedTools: string[]; droppedDigests: string[]; removedCalls: string[] } {
  const thinSet = new Set(thin);
  const dropSet = new Set(drop);
  const next: Message[] = [];
  const thinnedTools: string[] = [];
  const droppedDigests: string[] = [];
  const removedCalls: string[] = [];

  for (const seg of segments) {
    const slice = messages.slice(seg.range[0], seg.range[1]);
    if (dropSet.has(seg.index)) {
      droppedDigests.push(`${KIND_LABEL[seg.kind]}: ${seg.digest}`);
      continue; // セグメントごと消す (tool ペアは同一セグメント内なので分断されない)
    }
    if (!thinSet.has(seg.index)) {
      next.push(...slice);
      continue;
    }
    const thinned = thinSlice(seg.kind, slice);
    next.push(...thinned.messages);
    thinnedTools.push(...thinned.thinnedTools);
    removedCalls.push(...thinned.removedCalls);
  }

  return { next, thinnedTools, droppedDigests, removedCalls };
}

/** 長い文字列を先頭 THIN_TEXT_CHARS 文字 + 省略注記に切り詰める。 thin 済み・短文はそのまま */
function shrinkText(text: string): string {
  if (text.length <= THIN_TEXT_CHARS || text.includes(THINNED_MARKER)) return text;
  const dropped = estimateTokens(text.slice(THIN_TEXT_CHARS));
  return (
    `${text.slice(0, THIN_TEXT_CHARS)}\n` +
    `${THINNED_MARKER} 以降 約 ${dropped.toLocaleString("en-US")} トークンを履歴から削除しました。`
  );
}

/** 1 セグメント分の messages に thin を適用する (元配列は変更しない) */
function thinSlice(
  kind: SegmentKind,
  slice: Message[],
): { messages: Message[]; thinnedTools: string[]; removedCalls: string[] } {
  const messages: Message[] = [];
  const thinnedTools: string[] = [];
  const removedCalls: string[] = [];

  if (kind === "tool_batch") {
    // 引数が短い tool_call は残し、 結果本文だけ落とす。 呼び出しごと消すと
    // 「このファイルを読んだ」 という行動の記録まで失われ、 読み直しループを誘発する (docs §3.1)。
    //
    // 引数に本文を持つ tool_call は、 呼び出しと結果の対ごと履歴から外し、
    // 何をしたかの 1 行記録をトゥームストーンへ移す。 引数を「先頭 N 文字 + [忘却済み]」 に
    // 書き換えて残すと、 モデルがそれを自分の呼び出しの書き方として真似し、
    // 途中で切れたコマンドや本文を実際に出力する (2026-10-18〜19 myppt セッションで 12 件:
    // git commit の引用符が閉じず bash が構文エラー、 切れたスクリプトを file_write 等)。
    // 呼び出しごとの変換と組への当てはめは段階 1 (reduction-stages.ts) と共通。
    const head = slice[0];
    const resultById = new Map(slice.slice(1).map((m) => [m.tool_call_id, m]));
    const actions = new Map<string, ToolCallAction>();
    for (const c of head.tool_calls ?? []) {
      const result = resultById.get(c.id);
      if (hasBulkyArguments(c.function.arguments)) {
        actions.set(c.id, { kind: "remove" });
        removedCalls.push(describeRemovedCall(c, result));
        continue;
      }
      if (!result) continue;
      const text = contentToText(result.content);
      // thin 済み。 再変換しても縮まらない
      if (text.startsWith(THINNED_MARKER)) continue;
      thinnedTools.push(c.function.name);
      actions.set(c.id, { kind: "replace-result", content: forgottenResultText(c, text, "thin") });
    }
    return { messages: transformToolBatch(slice, actions), thinnedTools, removedCalls };
  }

  // user / assistant_text: 先頭 THIN_TEXT_CHARS 文字 + 省略注記に切り詰める
  for (const m of slice) {
    const text = contentToText(m.content);
    const shrunkText = shrinkText(text);
    if (shrunkText === text) {
      messages.push(m);
      continue;
    }
    const shrunk: Message = { role: m.role, content: shrunkText };
    if (m.tool_call_id) shrunk.tool_call_id = m.tool_call_id;
    messages.push(shrunk);
  }
  return { messages, thinnedTools, removedCalls };
}

/** トゥームストーン本文を組み立てる (docs §4.4) */
export function buildTombstoneText(params: {
  segmentCount: number;
  freedTokens: number;
  thinnedTools: string[];
  droppedDigests: string[];
  /** 呼び出しごと履歴から外した tool_call の 1 行記録 (引数に本文を持つもの。 docs §3.1) */
  removedCalls?: string[];
}): string {
  const lines = [
    `${TOMBSTONE_MARKER} ${params.segmentCount} セグメント / 約 ${params.freedTokens.toLocaleString("en-US")} トークンを履歴から削除しました。`,
  ];
  if (params.thinnedTools.length > 0) {
    lines.push(`- 本文のみ削除 (行動の記録は残存): ${summarizeToolNames(params.thinnedTools)}`);
  }
  const removed = params.removedCalls ?? [];
  if (removed.length > 0) {
    lines.push("- 実行済み (呼び出しと結果の本文は削除):");
    for (const r of removed.slice(0, REMOVED_CALLS_LISTED)) lines.push(`  - ${r}`);
    if (removed.length > REMOVED_CALLS_LISTED) lines.push(`  - ほか ${removed.length - REMOVED_CALLS_LISTED} 件`);
  }
  if (params.droppedDigests.length > 0) {
    for (const d of params.droppedDigests.slice(0, 5)) lines.push(`- 完全削除: ${d}`);
    if (params.droppedDigests.length > 5) {
      lines.push(`- 完全削除: ほか ${params.droppedDigests.length - 5} 件`);
    }
  }
  lines.push("必要になった情報は再度ツールで取得してください。");
  return lines.join("\n");
}

// ─── forget-thinking (決定論版・LLM 不使用) ───

/**
 * 再取得可能な読取系ツール (docs/context-strategy.md §2.1)。
 * これらの結果は **もう一度実行すれば同じものが手に入る**ので、 本文を落としてよい。
 * 逆に file_write / file_edit / bash などの「どう変更したか」 は履歴にしか残らないため残す。
 */
export const READONLY_TOOL_NAMES = new Set(["file_read", "grep", "glob", "web_fetch", "web_search"]);

/**
 * forget-thinking の対象セグメントを機械的に選ぶ。
 *   - user / assistant_text は全て残す (無劣化)
 *   - 読取系ツールのみで構成される tool_batch を thin する
 *   - 書込・実行を 1 つでも含む tool_batch は残す
 * モデルに問い合わせないので待ち時間はほぼゼロ。 ここが速さの肝。
 */
export function selectThinkingTargets(segments: Segment[]): number[] {
  const thin: number[] = [];
  for (const s of segments) {
    if (s.protected) continue;
    if (s.kind !== "tool_batch") continue;
    // thin 済みを選び直すと「約 0 トークン削除」 の空振り記録だけがトゥームストーンに積もる
    if (s.thinGain <= 0) continue;
    const names = s.toolNames ?? [];
    if (names.length === 0) continue;
    if (!names.every((n) => READONLY_TOOL_NAMES.has(n))) continue;
    thin.push(s.index);
  }
  return thin;
}

export interface ForgetThinkingResult {
  applied: boolean;
  /** 実削減トークン数 (適用前後の推定差) */
  freedTokens: number;
  /** thin した tool_batch の数 */
  thinnedSegments: number;
  /** 削除した assistant.thinking の数 */
  clearedThinking: number;
  reason?: string;
}

/**
 * 「探索は捨てる、 やったことと言ったことは残す」 を LLM 無しで適用する
 * (docs/context-strategy.md §2.1)。
 *
 * 実測上コンテキストの最大の占有源である読取系ツールの結果本文が消えるので、
 * 区切りのたびに気軽に走らせられる = そもそも閾値に到達しなくなる。
 */
export function forgetThinking(
  history: MessageHistory,
  keepRecentSegments = DEFAULT_KEEP_RECENT_SEGMENTS,
): ForgetThinkingResult {
  // 送信時の実サイズで測る。 thinking は getMessages() で本文に inline されるため、
  // getRawMessages() ではなくこちらを使わないと thinking 削除分が計上されない。
  const beforeTokens = estimateMessageTokens(history.getMessages());
  const before = history.getRawMessages();

  // 思考は区切りを越えたら不要 (span 内で消費し終えた scratch)。
  // 注: clearAllThinking() は Message を直接書き換えるため、 以降のロールバックでも
  // thinking は戻らない。 thinking はもともと span 境界で破棄される scratch なので許容する。
  const clearedThinking = history.clearAllThinking();

  const segments = buildSegments(history.getRawMessages(), keepRecentSegments);
  const thin = selectThinkingTargets(segments);

  if (thin.length === 0) {
    const freedTokens = Math.max(0, beforeTokens - estimateMessageTokens(history.getMessages()));
    return {
      applied: clearedThinking > 0,
      freedTokens,
      thinnedSegments: 0,
      clearedThinking,
      reason: clearedThinking > 0 ? undefined : "忘却できる読取系ツール結果がありません",
    };
  }

  const { next, thinnedTools, droppedDigests, removedCalls } = applyPlanToMessages(
    history.getRawMessages(),
    segments,
    thin,
    [],
  );
  const firstSeg = segments.find((s) => s.index === thin[0]);
  const insertAt = firstSeg ? Math.min(firstSeg.range[0], next.length) : next.length;
  const tombstone = buildTombstoneText({
    segmentCount: thin.length,
    freedTokens: Math.max(0, estimateMessageTokens(history.getRawMessages()) - estimateMessageTokens(next)),
    thinnedTools,
    droppedDigests,
    removedCalls,
  });
  const withTombstone = insertTombstone(next, tombstone, insertAt);

  try {
    history.replaceMessages(withTombstone);
  } catch (e) {
    logger.error(`[forget-thinking] 適用後の履歴が不整合のためロールバックしました: ${e}`);
    try {
      history.replaceMessages(before);
    } catch (e2) {
      logger.error(`[forget-thinking] ロールバック先の履歴も不整合でした: ${e2}`);
    }
    return {
      applied: false,
      freedTokens: 0,
      thinnedSegments: 0,
      clearedThinking,
      reason: `適用後の履歴が不整合のためロールバックしました: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const freedTokens = beforeTokens - estimateMessageTokens(history.getMessages());
  if (freedTokens <= 0) {
    // 情報だけ失って削減が無いなら忘却する意味がない (トゥームストーンの方が大きいケース)
    logger.info(`[forget-thinking] 実質削減が ${freedTokens} トークンのため適用を取り消しました`);
    try {
      history.replaceMessages(before);
    } catch (e) {
      logger.error(`[forget-thinking] ロールバック先の履歴も不整合でした: ${e}`);
    }
    return {
      applied: false,
      freedTokens: 0,
      thinnedSegments: 0,
      clearedThinking,
      reason: "実質的にトークンが削減できないため適用しませんでした",
    };
  }

  logger.info(
    `[forget-thinking] thin=${thin.length} thinking=${clearedThinking} 削減=${freedTokens} トークン (LLM 呼び出しなし)`,
  );
  return { applied: true, freedTokens, thinnedSegments: thin.length, clearedThinking };
}

// ─── エンジン ───

export interface ForgettingEngineOptions {
  keepRecentSegments?: number;
}

export class ForgettingEngine {
  private keepRecentSegments: number;
  /** 直近の忘却実績 (/forget status 表示用) */
  private lastResult: ForgetResult | null = null;
  private lastAt: number | null = null;

  constructor(
    private provider: LLMProvider,
    private model: string,
    opts: ForgettingEngineOptions = {},
  ) {
    this.keepRecentSegments = opts.keepRecentSegments ?? DEFAULT_KEEP_RECENT_SEGMENTS;
  }

  setProvider(provider: LLMProvider, model: string): void {
    this.provider = provider;
    this.model = model;
  }

  setKeepRecentSegments(value: number): void {
    if (value > 0) this.keepRecentSegments = value;
  }

  getLastResult(): { result: ForgetResult; at: number } | null {
    return this.lastResult && this.lastAt ? { result: this.lastResult, at: this.lastAt } : null;
  }

  /**
   * 忘却プランを作る (適用はしない)。
   * JSON パース失敗は同じ忘却経路で 1 回だけ再試行し、それでもだめなら null を返す。
   * forget 単独モードは失敗を報告し、hybrid のみ明示された圧縮段階へ進む。
   */
  async plan(messages: Message[], targetTokens: number): Promise<ForgetPlan | null> {
    return (await this.planWithReason(messages, targetTokens)).plan;
  }

  /**
   * plan() の本体。 不成立のときは「なぜ作れなかったか」 を reason に入れて返す。
   * 原因ごとに打ち手が違う (思考で上限到達 / JSON 崩れ / 選択 0 件 / 対象なし) ため、
   * 1 つの文言にまとめず利用者に見せる (docs §4.5)。
   */
  async planWithReason(
    messages: Message[],
    targetTokens: number,
  ): Promise<{ plan: ForgetPlan | null; reason?: string }> {
    const segments = buildSegments(messages, this.keepRecentSegments);
    const forgettable = segments.filter((s) => !s.protected);
    if (forgettable.length === 0) {
      logger.info("[forget] 忘却可能なセグメントがありません (すべて保護)");
      return { plan: null, reason: "忘却できるセグメントがありません (直近の作業とノートはすべて保護対象)" };
    }

    const manifest = buildManifest(segments);
    const prompt = buildForgetPrompt(manifest, targetTokens);

    let choice: RawForgetChoice | null = null;
    // 2 回とも失敗したときに見せる、 最後の試行の失敗内容
    let lastFailure = "";
    for (let attempt = 0; attempt < 2 && !choice; attempt++) {
      try {
        const gen = sideCall("forget-select", this.provider, {
          method: "chat",
          params: {
            model: this.model,
            messages: [
              {
                role: "system",
                content:
                  "You are a fast classifier for context reduction. Keep internal thinking very brief (under 50 words) and output the requested JSON directly without hesitation.",
              },
              { role: "user", content: prompt },
            ],
            temperature: FORGET_TEMPERATURE,
            maxTokens: FORGET_MAX_TOKENS,
            // 思考モデルは「思考は短く」 を守らず上限を思考だけで使い切る (docs §4.2)
            disableThinking: true,
            stream: true,
          },
        });
        const response = await collectResponse(gen);
        const trimmed = response.content.trim();
        if (trimmed.length === 0) {
          const completion = response.usage?.completionTokens;
          lastFailure =
            `モデルの応答本文が空でした (finishReason=${response.finishReason ?? "unknown"}, 出力 ${completion ?? "不明"} トークン)` +
            (response.finishReason === "length"
              ? `。 出力上限 ${FORGET_MAX_TOKENS} トークンを思考だけで使い切った可能性があります`
              : "");
          logger.warn(`[forget] ${lastFailure} (試行 ${attempt + 1}/2)`);
          continue;
        }
        choice = parseForgetResponse(trimmed);
        if (!choice) {
          lastFailure = `モデルの応答を JSON として読めませんでした: ${oneLine(trimmed, 80)}`;
          logger.warn(`[forget] JSON パースに失敗 (試行 ${attempt + 1}/2): ${oneLine(trimmed, 200)}`);
        }
      } catch (e) {
        if (isRateLimitError(e)) throw e;
        lastFailure = `忘却選択の LLM 呼び出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`;
        logger.warn(`[forget] 忘却選択の LLM 呼び出しに失敗 (試行 ${attempt + 1}/2): ${e}`);
      }
    }
    if (!choice) return { plan: null, reason: `${lastFailure} (2 回試行)` };

    const { thin, drop, warnings } = validateChoice(segments, choice);
    if (thin.length === 0 && drop.length === 0) {
      // 「何も忘れない」 は安全側だが縮約としては不成立として返す。
      logger.info("[forget] モデルが thin/drop を 1 件も選ばなかったため忘却は不成立");
      const ignored = warnings.length > 0 ? ` (無効な指定 ${warnings.length} 件を除外: ${warnings[0]})` : "";
      return { plan: null, reason: `モデルが忘れる対象を 1 件も選びませんでした${ignored}` };
    }

    const before = estimateMessageTokens(messages);
    const { next } = applyPlanToMessages(messages, segments, thin, drop);
    const estimatedFreedTokens = Math.max(0, before - estimateMessageTokens(next));

    return {
      plan: {
        segments,
        thin,
        drop,
        reason: choice.reason,
        warnings,
        targetTokens,
        estimatedFreedTokens,
      },
    };
  }

  /**
   * 控えに戻す。 控え自体が不整合だった場合 (忘却より前から壊れていた場合) は
   * ここで投げても事態が良くならないので、 記録だけ残して握る。
   */
  private restore(history: MessageHistory, before: Message[]): void {
    try {
      history.replaceMessages(before);
    } catch (e) {
      logger.error(`[forget] ロールバック先の履歴も不整合でした (忘却前から壊れています): ${e}`);
    }
  }

  /**
   * プランを履歴に適用する。 適用前の控えを取り、 ペア整合が壊れていれば控えに戻す。
   * 忘却の失敗で会話が壊れることは無い (docs §5)。
   */
  applyPlan(history: MessageHistory, plan: ForgetPlan): ForgetResult {
    const before = history.getRawMessages();
    const beforeTokens = estimateMessageTokens(before);

    const { next, thinnedTools, droppedDigests, removedCalls } = applyPlanToMessages(
      before,
      plan.segments,
      plan.thin,
      plan.drop,
    );
    const freedBeforeTombstone = Math.max(0, beforeTokens - estimateMessageTokens(next));

    // トゥームストーンは「最初に忘却した位置」 に置く。 何が消えたか分からない状態を作らない
    const firstTouched = Math.min(...[...plan.thin, ...plan.drop]);
    const firstSeg = plan.segments.find((s) => s.index === firstTouched);
    const insertAt = firstSeg ? Math.min(firstSeg.range[0], next.length) : next.length;
    const tombstone = buildTombstoneText({
      segmentCount: plan.thin.length + plan.drop.length,
      freedTokens: freedBeforeTombstone,
      thinnedTools,
      droppedDigests,
      removedCalls,
    });
    const withTombstone = insertTombstone(next, tombstone, insertAt);

    try {
      history.replaceMessages(withTombstone);
    } catch (e) {
      // 壊れた履歴を送ると provider が 400 を返すため、 控えに戻して忘却を無かったことにする。
      // (replaceMessages は検証を通ってから代入するので実際には未変更だが、 意図を明示するため戻す)
      logger.error(`[forget] 適用後の履歴が不整合のためロールバックしました: ${e}`);
      this.restore(history, before);
      const failed: ForgetResult = {
        applied: false,
        freedTokens: 0,
        thinnedSegments: 0,
        droppedSegments: 0,
        plan,
        reason: `適用後の履歴が不整合のためロールバックしました: ${e instanceof Error ? e.message : String(e)}`,
      };
      this.lastResult = failed;
      this.lastAt = Date.now();
      return failed;
    }

    // トゥームストーン込みで実質削減が無い (むしろ増える) なら忘却する意味がない。
    // 情報だけ失って context が減らない最悪のケースを避けるため、 その場合も控えに戻す。
    const freedTokens = beforeTokens - estimateMessageTokens(history.getRawMessages());
    if (freedTokens <= 0) {
      logger.info(`[forget] 実質削減が ${freedTokens} トークンのため適用を取り消しました`);
      this.restore(history, before);
      const noGain: ForgetResult = {
        applied: false,
        freedTokens: 0,
        thinnedSegments: 0,
        droppedSegments: 0,
        plan,
        reason: "選択されたセグメントでは実質的にトークンが削減できないため適用しませんでした",
      };
      this.lastResult = noGain;
      this.lastAt = Date.now();
      return noGain;
    }

    const result: ForgetResult = {
      applied: true,
      freedTokens,
      thinnedSegments: plan.thin.length,
      droppedSegments: plan.drop.length,
      plan,
    };
    this.lastResult = result;
    this.lastAt = Date.now();
    logger.info(
      `[forget] thin=${plan.thin.length} drop=${plan.drop.length} 削減=${result.freedTokens} トークン (目標 ${plan.targetTokens})`,
    );
    return result;
  }

  /** プラン作成 → 適用までを 1 回で行う */
  async forget(history: MessageHistory, targetTokens: number): Promise<ForgetResult> {
    const { plan, reason } = await this.planWithReason(history.getRawMessages(), targetTokens);
    if (!plan) {
      const failed: ForgetResult = {
        applied: false,
        freedTokens: 0,
        thinnedSegments: 0,
        droppedSegments: 0,
        plan: null,
        reason: `忘却プランを作れませんでした: ${reason ?? "理由不明"}`,
      };
      this.lastResult = failed;
      this.lastAt = Date.now();
      return failed;
    }
    return this.applyPlan(history, plan);
  }

  /** 適用せずにプランだけ出す (/forget dry) */
  async dryRun(history: MessageHistory, targetTokens: number): Promise<ForgetDryRunReport> {
    const messages = history.getRawMessages();
    const segments = buildSegments(messages, this.keepRecentSegments);
    const manifest = buildManifest(segments);
    const { plan, reason } = await this.planWithReason(messages, targetTokens);
    return {
      manifest,
      plan,
      reason: plan ? undefined : `忘却プランを作れませんでした: ${reason ?? "理由不明"}`,
    };
  }
}
