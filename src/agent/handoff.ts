/**
 * 引き継ぎメモ + Clear (docs/context-strategy.md §2.2)
 *
 * 「次やることの指示を残して、 一度コンテキストをクリア」 を実現する。
 *
 *   1. 現在の履歴から引き継ぎメモを LLM に書かせる
 *   2. セッションを保存する (/resume で完全な履歴に戻れる状態を作ってから消す)
 *   3. history.clear()
 *   4. 引き継ぎメモを最初の user メッセージとして再投入
 *   5. 引き継ぎメモをユーザーにも表示する
 *
 * 最重要の約束: **引き継ぎメモの生成に成功してから clear する**。
 * 生成に失敗したら履歴には一切触れない (docs §8)。 履歴だけ消えてメモが無い、
 * という最悪のケースを構造的に起こさない。
 */
import type { LLMProvider, Message } from "../providers/base-provider.js";
import { collectResponse } from "../providers/base-provider.js";
import type { MessageHistory } from "./message-history.js";
import { estimateMessageTokens } from "./token-counter.js";
import * as logger from "../utils/logger.js";

/** 引き継ぎメモ生成のサンプリング。 事実の書き写しなので決定論寄りに倒す */
const HANDOFF_TEMPERATURE = 0.2;
/** メモは長くならない方が良い (次の作業の入口で読むもの) */
const HANDOFF_MAX_TOKENS = 1200;

/** LLM に渡す会話ダイジェストの上限文字数。 これ以上は古い側から落とす */
const TRANSCRIPT_MAX_CHARS = 24_000;
/** 1 メッセージあたりの抜粋文字数 (ツール結果本文が全体を埋め尽くすのを防ぐ) */
const PER_MESSAGE_CHARS = 600;

/** メモとして最低限の体裁を満たす長さ。 これ未満なら生成失敗とみなす */
const MIN_NOTE_CHARS = 40;

/** 履歴に再投入するときの目印。 引き継ぎ由来の user メッセージだと判別できるようにする */
export const HANDOFF_MARKER = "[引き継ぎメモ]";

/** テンプレートの節見出し。 モデルにはこの形を固定で埋めさせる (docs §2.2) */
export const HANDOFF_SECTIONS = [
  "## これまでにやったこと",
  "## 次にやること",
  "## 守るべき制約・決定事項",
  "## 関係するファイル",
] as const;

export const HANDOFF_TEMPLATE = [
  "## これまでにやったこと",
  "- (完了した作業を箇条書き。 結論のみ)",
  "",
  "## 次にやること",
  "- (未完了のタスク。 最初に着手すべきものを先頭に)",
  "",
  "## 守るべき制約・決定事項",
  "- (ユーザーが出した指示、 議論して決まった方針。 原文に近い形で)",
  "",
  "## 関係するファイル",
  "- path — 何のためのファイルか",
].join("\n");

// ─── 会話ダイジェスト ───

function contentToText(content: Message["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\r/g, "");
  return flat.length <= max ? flat : `${flat.slice(0, max)}…(以下略)`;
}

/**
 * LLM に見せる会話ダイジェストを作る。
 * 上限を超える場合は **古い側から落とす** (直近の方が引き継ぎに効くため)。
 * 落とした事実は先頭に明記する (黙って欠損させない)。
 */
export function buildTranscript(messages: Message[], maxChars = TRANSCRIPT_MAX_CHARS): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const names = m.tool_calls.map((c) => c.function.name).join(", ");
      const text = contentToText(m.content).trim();
      lines.push(`[assistant] ${text ? `${clip(text, PER_MESSAGE_CHARS)} ` : ""}(tool: ${names})`);
      continue;
    }
    if (m.role === "tool") {
      lines.push(`[tool結果] ${clip(contentToText(m.content), 200)}`);
      continue;
    }
    lines.push(`[${m.role}] ${clip(contentToText(m.content), PER_MESSAGE_CHARS)}`);
  }

  let dropped = 0;
  let total = lines.reduce((acc, l) => acc + l.length + 1, 0);
  while (total > maxChars && lines.length > 1) {
    const removed = lines.shift();
    total -= (removed?.length ?? 0) + 1;
    dropped++;
  }
  if (dropped > 0) {
    lines.unshift(`(古い ${dropped} 件は長さの都合で省略。 直近の履歴のみ掲載)`);
  }
  return lines.join("\n");
}

/** モデルへの指示文。 テンプレートを固定し、 埋めさせる形にする */
export function buildHandoffPrompt(transcript: string): string {
  return (
    `以下はこれまでの会話履歴です。 ここでコンテキストを一度リセットします。\n` +
    `リセット後の自分が作業を続けられるように、 引き継ぎメモを書いてください。\n\n` +
    `注意:\n` +
    `- 下のテンプレートの見出しをそのまま使い、 各節を埋めてください\n` +
    `- 「守るべき制約・決定事項」 には、 ユーザーが出した指示や議論して決まった方針を **原文に近い形で** 書いてください\n` +
    `  (履歴は完全に消えるので、 ここが唯一の拠り所になります。 要約して丸めないでください)\n` +
    `- 該当が無い節は「- なし」 と書いてください\n` +
    `- メモ本文だけを出力してください (前置き・後書きは不要)\n\n` +
    `## テンプレート\n${HANDOFF_TEMPLATE}\n\n` +
    `## これまでの会話\n${transcript}\n`
  );
}

// ─── 検証 ───

/**
 * モデル出力を引き継ぎメモとして受理できるか検証する。
 * 受理できなければ null (呼び出し側は clear せずに格下げする)。
 *
 * 「テンプレートの節が 2 つ以上あること」 を条件にするのは、 節の分離こそが
 * このメモの価値 (制約が他の情報に混ざって薄まらない) だからである。
 */
export function validateHandoffNote(raw: string): string | null {
  if (!raw) return null;
  // ```markdown フェンスを剥がす
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  // 先頭の前置きを落とす: 最初の見出しから始める
  const firstHeading = text.indexOf("## ");
  if (firstHeading > 0) text = text.slice(firstHeading);

  if (text.length < MIN_NOTE_CHARS) return null;
  const present = HANDOFF_SECTIONS.filter((h) => text.includes(h));
  if (present.length < 2) return null;
  return text;
}

// ─── 生成 ───

export interface HandoffNoteResult {
  note: string | null;
  reason?: string;
}

/**
 * 引き継ぎメモを生成する。 LLM 呼び出しは 1 回 + 検証失敗時に 1 回だけ再試行。
 * どちらも失敗したら note=null を返す (履歴は絶対に触らない)。
 */
export async function generateHandoffNote(
  provider: LLMProvider,
  model: string,
  messages: Message[],
): Promise<HandoffNoteResult> {
  if (messages.length === 0) {
    return { note: null, reason: "履歴が空のため引き継ぎメモを作れません" };
  }
  const prompt = buildHandoffPrompt(buildTranscript(messages));
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const gen = provider.chat({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: HANDOFF_TEMPERATURE,
        maxTokens: HANDOFF_MAX_TOKENS,
        stream: true,
      });
      const response = await collectResponse(gen);
      const note = validateHandoffNote(response.content);
      if (note) return { note };
      lastError = "テンプレートの節が揃っていません";
      logger.warn(`[handoff] 引き継ぎメモの検証に失敗 (試行 ${attempt + 1}/2): ${lastError}`);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      logger.warn(`[handoff] 引き継ぎメモの生成に失敗 (試行 ${attempt + 1}/2): ${lastError}`);
    }
  }
  return { note: null, reason: `引き継ぎメモを生成できませんでした (${lastError})` };
}

// ─── 適用 ───

export interface HandoffResult {
  applied: boolean;
  note: string | null;
  freedTokens: number;
  /** clear 直前に保存したセッション ID (/resume で完全な履歴に戻れる) */
  savedSessionId?: string;
  reason?: string;
}

/** 再投入する user メッセージの本文を組み立てる */
export function buildHandoffMessage(note: string, savedSessionId?: string): string {
  const lines = [
    `${HANDOFF_MARKER} ここまでの会話履歴はコンテキスト整理のためリセットされました。`,
    `以下があなた自身が残した引き継ぎメモです。 これを前提に作業を続けてください。`,
  ];
  if (savedSessionId) {
    lines.push(`(リセット前の完全な履歴はセッション ${savedSessionId} に保存済みです)`);
  }
  lines.push("", note);
  return lines.join("\n");
}

export interface HandoffOptions {
  /**
   * clear 直前にセッションを保存する。 /resume で完全復元できる状態を作ってから消す。
   * 保存したセッション ID を返すと、 引き継ぎメモに復元先として併記する。
   */
  saveSession?: () => string | undefined;
}

/**
 * 引き継ぎメモを作って履歴をリセットする。
 * メモの生成に失敗した場合は **履歴を一切変更せず** applied=false を返す。
 */
export async function runHandoff(
  provider: LLMProvider,
  model: string,
  history: MessageHistory,
  opts: HandoffOptions = {},
): Promise<HandoffResult> {
  const beforeTokens = estimateMessageTokens(history.getMessages());
  const { note, reason } = await generateHandoffNote(provider, model, history.getRawMessages());
  if (!note) {
    return { applied: false, note: null, freedTokens: 0, reason: reason ?? "引き継ぎメモを生成できませんでした" };
  }

  // 消す前に保存する。 これが /resume での完全復元の担保になる
  let savedSessionId: string | undefined;
  try {
    const id = opts.saveSession?.();
    if (typeof id === "string") savedSessionId = id;
  } catch (e) {
    logger.warn(`[handoff] clear 前のセッション保存に失敗しました: ${e}`);
  }

  history.clear();
  history.addUserMessage(buildHandoffMessage(note, savedSessionId));

  const afterTokens = estimateMessageTokens(history.getMessages());
  const freedTokens = Math.max(0, beforeTokens - afterTokens);
  logger.info(`[handoff] 履歴をリセットしました (約 ${freedTokens} トークン削減)`);
  return { applied: true, note, freedTokens, savedSessionId };
}
