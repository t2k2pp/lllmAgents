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
import { collectResponse } from "../providers/base-provider.js";
import { estimateTokens, estimateMessageTokens } from "./token-counter.js";
import type { MessageHistory } from "./message-history.js";
import * as logger from "../utils/logger.js";

// ─── 定数 ───

/** 忘却選択の LLM 呼び出しのサンプリング設定。 分類タスクなので決定論寄りに倒す */
const FORGET_TEMPERATURE = 0.1;
/** JSON 1 個を返させるだけなので出力上限は小さくてよい */
const FORGET_MAX_TOKENS = 600;

/** 直近何セグメントを保護するか (既定) */
export const DEFAULT_KEEP_RECENT_SEGMENTS = 6;

/** digest に載せる本文の文字数 (マニフェスト 1 行に収める) */
const DIGEST_CHARS = 60;

/** thin したテキストで残す先頭文字数 (docs §3.1) */
const THIN_TEXT_CHARS = 200;

/** トゥームストーンの目印。 これで system_note を再識別する */
export const TOMBSTONE_MARKER = "[忘却の記録]";

/** thin 済み tool_result の目印 */
export const THINNED_MARKER = "[忘却済み]";

// ─── 型 ───

export type SegmentKind = "user" | "assistant_text" | "tool_batch" | "system_note";

export interface Segment {
  /** 履歴内の 1 始まり通し番号。 モデルはこの番号で忘却対象を指す */
  index: number;
  kind: SegmentKind;
  /** このセグメントに含まれる messages の [開始, 終了) */
  range: [number, number];
  /** 推定トークン数 */
  tokens: number;
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

function contentToText(content: Message["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** 改行・連続空白を潰して 1 行に収める */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** tool_calls の引数から代表的なパス等を 1 つ拾う (digest 用) */
function pickRepresentativeArg(msg: Message): string | undefined {
  const calls = msg.tool_calls ?? [];
  for (const c of calls) {
    try {
      const args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
      for (const key of ["file_path", "path", "pattern", "command", "url", "query"]) {
        const v = args[key];
        if (typeof v === "string" && v.trim().length > 0) return oneLine(v, 40);
      }
    } catch {
      // 引数が壊れていても digest は best-effort でよい
    }
  }
  return undefined;
}

/** ツール名を `名前×回数` に集計する */
function summarizeToolNames(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()].map(([n, c]) => `${n}×${c}`).join(", ");
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
      digest: oneLine(contentToText(msg.content), DIGEST_CHARS),
      // 圧縮要約 / 忘却トゥームストーンの system は常に保護 (docs §2.2)
      protected: kind === "system_note",
    });
    i++;
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
    lines.push(`${num}${kind}${tok}  ${s.digest}`);
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
    `「保護」 と書かれた行は選べません。\n\n` +
    `JSON のみを返してください:\n` +
    `{"thin": [2, 4], "drop": [], "reason": "巨大なソース読み込みの本文を落とした。 指示と判断は全て残した"}\n\n` +
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
      thin.add(idx);
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

/** tool_call の引数から「何をしたか」 を 1 行で復元する (thin 後の代替テキスト用) */
function describeToolCall(name: string, argsJson: string): string {
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
 * プランを適用した新しいメッセージ列を作る (元配列は変更しない)。
 * 適用位置は範囲の重複が起きないよう segment.range をそのまま使う。
 */
export function applyPlanToMessages(
  messages: Message[],
  segments: Segment[],
  thin: number[],
  drop: number[],
): { next: Message[]; thinnedTools: string[]; droppedDigests: string[] } {
  const thinSet = new Set(thin);
  const dropSet = new Set(drop);
  const next: Message[] = [];
  const thinnedTools: string[] = [];
  const droppedDigests: string[] = [];

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

    if (seg.kind === "tool_batch") {
      // tool_call は残す。 消すと「このファイルを読んだ」 という行動の記録まで失われ、
      // 同じファイルを何度も読み直すループを誘発する (docs §3.1)。
      const head = slice[0];
      const callById = new Map((head.tool_calls ?? []).map((c) => [c.id, c]));
      next.push(head);
      for (const m of slice.slice(1)) {
        const call = m.tool_call_id ? callById.get(m.tool_call_id) : undefined;
        const what = call ? describeToolCall(call.function.name, call.function.arguments) : "ツール";
        const tokens = estimateTokens(contentToText(m.content));
        thinnedTools.push(call?.function.name ?? "tool");
        next.push({
          role: "tool",
          content:
            `${THINNED_MARKER} ${what} の結果 (約 ${tokens.toLocaleString("en-US")} トークン) は履歴から削除しました。 ` +
            `必要なら再度実行して取得してください。`,
          tool_call_id: m.tool_call_id,
        });
      }
      continue;
    }

    // user / assistant_text: 先頭 THIN_TEXT_CHARS 文字 + 省略注記に切り詰める
    for (const m of slice) {
      const text = contentToText(m.content);
      if (text.length <= THIN_TEXT_CHARS) {
        next.push(m);
        continue;
      }
      const dropped = estimateTokens(text.slice(THIN_TEXT_CHARS));
      const shrunk: Message = {
        role: m.role,
        content:
          `${text.slice(0, THIN_TEXT_CHARS)}\n` +
          `${THINNED_MARKER} 以降 約 ${dropped.toLocaleString("en-US")} トークンを履歴から削除しました。`,
      };
      if (m.tool_call_id) shrunk.tool_call_id = m.tool_call_id;
      next.push(shrunk);
    }
  }

  return { next, thinnedTools, droppedDigests };
}

/** トゥームストーン本文を組み立てる (docs §4.4) */
export function buildTombstoneText(params: {
  segmentCount: number;
  freedTokens: number;
  thinnedTools: string[];
  droppedDigests: string[];
}): string {
  const lines = [
    `${TOMBSTONE_MARKER} ${params.segmentCount} セグメント / 約 ${params.freedTokens.toLocaleString("en-US")} トークンを履歴から削除しました。`,
  ];
  if (params.thinnedTools.length > 0) {
    lines.push(`- 本文のみ削除 (行動の記録は残存): ${summarizeToolNames(params.thinnedTools)}`);
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

/**
 * トゥームストーンを挿入する。 既存のトゥームストーンがあれば追記統合し、
 * 無ければ「最初に忘却した位置」 に 1 件だけ挿入する (履歴中に散乱させない)。
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

  const { next, thinnedTools, droppedDigests } = applyPlanToMessages(history.getRawMessages(), segments, thin, []);
  const firstSeg = segments.find((s) => s.index === thin[0]);
  const insertAt = firstSeg ? Math.min(firstSeg.range[0], next.length) : next.length;
  const tombstone = buildTombstoneText({
    segmentCount: thin.length,
    freedTokens: Math.max(0, estimateMessageTokens(history.getRawMessages()) - estimateMessageTokens(next)),
    thinnedTools,
    droppedDigests,
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
    const segments = buildSegments(messages, this.keepRecentSegments);
    const forgettable = segments.filter((s) => !s.protected);
    if (forgettable.length === 0) {
      logger.info("[forget] 忘却可能なセグメントがありません (すべて保護)");
      return null;
    }

    const manifest = buildManifest(segments);
    const prompt = buildForgetPrompt(manifest, targetTokens);

    let choice: RawForgetChoice | null = null;
    for (let attempt = 0; attempt < 2 && !choice; attempt++) {
      try {
        const gen = this.provider.chat({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: FORGET_TEMPERATURE,
          maxTokens: FORGET_MAX_TOKENS,
          stream: true,
        });
        const response = await collectResponse(gen);
        choice = parseForgetResponse(response.content);
        if (!choice) {
          logger.warn(`[forget] JSON パースに失敗 (試行 ${attempt + 1}/2): ${oneLine(response.content, 200)}`);
        }
      } catch (e) {
        logger.warn(`[forget] 忘却選択の LLM 呼び出しに失敗 (試行 ${attempt + 1}/2): ${e}`);
      }
    }
    if (!choice) return null;

    const { thin, drop, warnings } = validateChoice(segments, choice);
    if (thin.length === 0 && drop.length === 0) {
      // 「何も忘れない」 は安全側だが縮約としては不成立として返す。
      logger.info("[forget] モデルが thin/drop を 1 件も選ばなかったため忘却は不成立");
      return null;
    }

    const before = estimateMessageTokens(messages);
    const { next } = applyPlanToMessages(messages, segments, thin, drop);
    const estimatedFreedTokens = Math.max(0, before - estimateMessageTokens(next));

    return {
      segments,
      thin,
      drop,
      reason: choice.reason,
      warnings,
      targetTokens,
      estimatedFreedTokens,
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

    const { next, thinnedTools, droppedDigests } = applyPlanToMessages(before, plan.segments, plan.thin, plan.drop);
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
    const plan = await this.plan(history.getRawMessages(), targetTokens);
    if (!plan) {
      const failed: ForgetResult = {
        applied: false,
        freedTokens: 0,
        thinnedSegments: 0,
        droppedSegments: 0,
        plan: null,
        reason: "忘却プランを作れませんでした (JSON パース失敗 / 選択 0 件 / 対象なし)",
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
    const plan = await this.plan(messages, targetTokens);
    return {
      manifest,
      plan,
      reason: plan ? undefined : "忘却プランを作れませんでした (JSON パース失敗 / 選択 0 件 / 対象なし)",
    };
  }
}
