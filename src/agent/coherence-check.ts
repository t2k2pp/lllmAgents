/**
 * Thinking-Text コヒーレンス検出 (Axis 2a)
 *
 * docs/strategic-todo-design.md 議論 (2026-05-16) で固まった設計:
 * - model の thinking 内に「続きを示唆する記述」 があるのに、 text や response_complete で
 *   「完了」 を宣言しているズレを検出する
 * - 弱モデルが「とりあえず返す」 「output が長くなったから一旦切る」 をしてしまうケースを拾う
 * - regex ベース、 軽量 (LLM 呼出なし)
 * - 緩めパターン (user 指示): 兆候レベルで拾う、 false positive はある程度許容
 *
 * 用途: response 受信後、 span 終了判定の前に走らせ、 ズレ検出時に nudge を inject
 */

/**
 * 「続きがある」 を示唆する thinking 内の表現。 緩め (兆候を多めに拾う)。
 */
const CONTINUATION_PATTERNS: ReadonlyArray<RegExp> = [
  /次に[はがの]?/,
  /(あと|後)で/,
  /続き/,
  /残り/,
  /予定/,
  /もう少し/,
  /追って/,
  /次回/,
  /引き続き/,
  /これから/,
  /(続け|つづけ)て/,
  /\bnext\b/i,
  /\blater\b/i,
  /still\s+(need|have|got)/i,
  /to\s+be\s+continued/i,
];

/**
 * 「完了」 を示唆する text or completion 系の表現。 緩め。
 */
const COMPLETION_PATTERNS: ReadonlyArray<RegExp> = [
  /完了(しました|です|致しました|いたしました)?/,
  /終わり(です|ました)?/,
  /以上/,
  /^OK[。、!]?$/m,
  /これで(完了|終了|完成|大丈夫)/,
  /(ここまで|今回は)/,
  /(よろしいでしょうか|でしょうか[。?])/,
  /\bdone\b/i,
  /\bfinished\b/i,
  /\bcomplete\b/i,
];

export interface CoherenceCheckResult {
  /** ズレを検出したか */
  mismatch: boolean;
  /** マッチした続き signal (debug 用) */
  continuationHit?: string;
  /** マッチした完了 signal (debug 用) */
  completionHit?: string;
}

/**
 * thinking-text コヒーレンス検査。
 *
 * 検出条件: thinking に continuation signal AND (text に completion signal OR response_complete 呼出)
 *
 * @param thinking 直前 LLM 応答の thinking 内容
 * @param text 直前 LLM 応答の text 内容
 * @param hasResponseComplete response_complete tool が呼ばれていたか
 */
export function checkCoherence(
  thinking: string,
  text: string,
  hasResponseComplete: boolean,
): CoherenceCheckResult {
  // 続き signal を thinking から検出
  let continuationHit: string | undefined;
  for (const pat of CONTINUATION_PATTERNS) {
    const m = thinking.match(pat);
    if (m) {
      continuationHit = m[0];
      break;
    }
  }
  if (!continuationHit) return { mismatch: false };

  // 完了 signal を text から検出 (or response_complete 呼出があれば自動的に完了)
  let completionHit: string | undefined;
  if (hasResponseComplete) {
    completionHit = "response_complete()";
  } else {
    for (const pat of COMPLETION_PATTERNS) {
      const m = text.match(pat);
      if (m) {
        completionHit = m[0];
        break;
      }
    }
  }
  if (!completionHit) return { mismatch: false };

  return { mismatch: true, continuationHit, completionHit };
}

/**
 * ズレ検出時に inject する nudge メッセージを構築。
 */
export function buildCoherenceNudge(result: CoherenceCheckResult): string {
  return `[ハーネス通知] あなたの thinking と text にズレがあります。
- thinking: 「${result.continuationHit}」 等、 続きを示唆する記述あり
- text/完了宣言: 「${result.completionHit}」 等、 完了を示唆

本当に終わっていますか? thinking で挙げた「次に / 続き」 を消化してから完了宣言してください。
- 続きの action がまだあるなら、 該当ツール (実装 tool or todo_append) を呼んで進める
- 思考と output のズレが意図的なら、 thinking の続き記述を撤回して明示してください`;
}
