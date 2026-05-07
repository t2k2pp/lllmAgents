/**
 * Phase E-3: タスク複雑度の分類とモデル推奨
 *
 * docs/multi-tier-harness-roadmap.md §4 Phase E-3 の実装。
 *
 * ユーザ発話から「タスクの重さ」 をヒューリスティックに推定し、 現在の能力ティアと
 * 比較して「もっと安いモデル / もっと賢いモデルが望ましい」 を**推奨**する。
 *
 * 設計方針: 自動切替はしない。 1 度推奨を console.log するだけ。 ユーザが /model で
 * 切り替えるかは判断に委ねる (= 操作の信頼性を維持)。
 *
 * 将来的に config の autoModelSelection が true なら自動切替する余地を残す。
 */

import type { Tier } from "./capability-tier.js";

export type TaskComplexity =
  | "simple-lookup" // 短い質問・調査・1 ファイル読込で済むレベル
  | "standard" // 通常の実装・修正
  | "complex"; // 大規模実装・複雑な設計・production 品質

/**
 * ユーザ発話からタスク複雑度を推定する (heuristic only — LLM 不使用で軽量)。
 *
 * - simple-lookup: 「何?」「どこ?」「教えて」「探して」 系の単発質問
 * - complex: 長文 (300+ 字) / 「全体」「production」「テスト」「設計書」 等の重キーワード
 * - standard: それ以外 (デフォルト)
 */
export function classifyTaskComplexity(userMessage: string): TaskComplexity {
  if (!userMessage) return "standard";
  const text = userMessage.trim();
  const len = text.length;

  // 極短メッセージは挨拶等 → simple-lookup
  if (len < 15) return "simple-lookup";

  // simple-lookup シグナル
  const simpleSignals = [
    /^(教えて|何|何ですか|どこ|どう思|意味|違いは|調べて|確認して|表示して|見せて|要約)/,
    /^(what|where|why|how|explain|show me|tell me|describe|summarize|find)/i,
    /^\?[a-zA-Z]/, // ?command 形式
  ];
  if (len < 80 && simpleSignals.some((re) => re.test(text))) {
    return "simple-lookup";
  }

  // complex シグナル
  const complexSignals = [
    /production|本番品質|テストまで|リリース|エンタープライズ|大規模/i,
    /設計書|アーキテクチャ|architecture|design doc/i,
    /(全体|全部|まとめて).*(再構築|書き直|作り直)/,
    /パフォーマンス|セキュリティ|reliability|performance|security/i,
  ];
  if (len >= 300 || complexSignals.some((re) => re.test(text))) {
    return "complex";
  }

  return "standard";
}

/**
 * タスク複雑度と現在のティアを照らし合わせて、 適性ティアを返す。
 * 適性ティア === 現ティア なら null (= 推奨なし)。
 *
 * 推奨ルール:
 *   complex タスク + T2/T3 → T1 推奨 ("品質のために強いモデルに切り替えては?")
 *   simple-lookup タスク + T1 → T2/T3 推奨 ("コスト節約に")
 *   その他は変更不要
 */
export function recommendTier(complexity: TaskComplexity, currentTier: Tier): Tier | null {
  if (complexity === "complex" && (currentTier === "T2" || currentTier === "T3")) {
    return "T1";
  }
  if (complexity === "simple-lookup" && currentTier === "T1") {
    return "T2"; // T3 まで落とすのは offer しない (= 機能性低下リスク)
  }
  return null;
}

/** 推奨理由を 1 行で返す (REPL での表示用) */
export function explainRecommendation(complexity: TaskComplexity, from: Tier, to: Tier): string {
  if (complexity === "complex" && to === "T1") {
    return `complex タスク (production / 設計書 / 大規模) を ${from} で扱うと品質リスクあり。 T1 (Claude/GPT-5) への切替を検討。`;
  }
  if (complexity === "simple-lookup" && to === "T2") {
    return `simple-lookup (短い質問・調査) を ${from} で扱うのはコスト過剰。 T2 (Kimi/Qwen32B) への切替で大幅節約可能。`;
  }
  return `complexity=${complexity} に対して ${to} の方が適性。`;
}
