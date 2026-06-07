/**
 * opt-in 入力圧縮 — 意図を保ったまま 1 つのテキスト塊をより少ないトークンへ圧縮する。
 *
 * 設計: docs/input-compression-design.md
 *
 * 原則:
 * - 塊ごとに**個別**に圧縮する (複数をまとめると受け手が感じる意図が変質するため)
 * - 会話履歴を含まない**クリーンな単発呼び出し** (メイン会話のコンテキストを汚さない)
 * - **サイズガード**: 圧縮後が圧縮前以上なら圧縮を破棄し原文を使う (縮まないのに lossy は最悪)
 * - 原文は呼び出し側が常に保持できるよう、結果に original を必ず含める
 */
import type { LLMProvider } from "../providers/base-provider.js";
import { collectResponse } from "../providers/base-provider.js";
import { estimateTokens } from "./token-counter.js";
import * as logger from "../utils/logger.js";

export interface CompressionResult {
  /** 実際に使うべきテキスト (圧縮が有効なら圧縮版、 そうでなければ原文) */
  text: string;
  /** 圧縮前の原文 (常に保持) */
  original: string;
  beforeTokens: number;
  afterTokens: number;
  /** 圧縮を適用したか (サイズガード/失敗で原文に戻した場合 false) */
  applied: boolean;
  /** 適用しなかった/できなかった理由 (任意) */
  note?: string;
}

const COMPRESS_TEMPERATURE = 0.3;
/** 圧縮要約の出力上限。 これ以上長いとそもそも圧縮目的に反する */
const COMPRESS_MAX_TOKENS = 2000;

/**
 * 圧縮プロンプト。 目的は「肥大化防止」 であって体裁の構造化ではない。
 * 意図・制約・固有名詞は保持し、 冗長だけを削るよう厳命する。
 */
function buildPrompt(label: string, text: string): string {
  return `次の「${label}」を、意図・制約を一切変えずに、より少ない文字数へ圧縮してください。

## 厳守
1. ユーザーの指示・制約 (「〜して」「〜禁止」「必ず」 等) は意味を保持する。 言い換えで弱めない
2. 固有名詞・ファイルパス・コマンド・関数名・数値・URL は省略しない
3. 重複・冗長・前置きを削る。 箇条書き化で密度を上げてよい
4. 新しい情報を足さない。 要約コメントや飾りの見出しを足さない

## 出力
圧縮後のテキストだけを返す (前置き・後書き・コードフェンス不要)。

---
${text}`;
}

/**
 * テキスト塊を圧縮する。 失敗・空応答・非縮小のいずれでも原文にフォールバックする
 * (applied=false)。 例外を投げない。
 */
export async function compressText(
  provider: LLMProvider,
  model: string,
  label: string,
  text: string,
): Promise<CompressionResult> {
  const beforeTokens = estimateTokens(text);
  try {
    const gen = provider.chat({
      model,
      messages: [{ role: "user", content: buildPrompt(label, text) }],
      temperature: COMPRESS_TEMPERATURE,
      maxTokens: COMPRESS_MAX_TOKENS,
      stream: true,
    });
    const response = await collectResponse(gen);
    const compressed = response.content.trim();
    const afterTokens = estimateTokens(compressed);

    // サイズガード: 空 or 縮まないなら原文を使う
    if (!compressed) {
      return { text, original: text, beforeTokens, afterTokens: 0, applied: false, note: "空応答のため原文を使用" };
    }
    if (afterTokens >= beforeTokens) {
      return {
        text,
        original: text,
        beforeTokens,
        afterTokens,
        applied: false,
        note: `圧縮後 ${afterTokens} >= 圧縮前 ${beforeTokens} tok のため原文を使用`,
      };
    }
    return { text: compressed, original: text, beforeTokens, afterTokens, applied: true };
  } catch (e) {
    logger.warn(`compressText failed for "${label}": ${e}`);
    return { text, original: text, beforeTokens, afterTokens: beforeTokens, applied: false, note: `圧縮失敗: ${e}` };
  }
}
