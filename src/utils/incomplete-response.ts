/**
 * LLMのレスポンスが構造的に途中で切れているかを判定する。
 *
 * 背景:
 *   vLLM等のOpenAI互換サーバーが finish_reason='stop' を返しても、
 *   実際にはモデル側が意図せぬEOSトークンや不正なチャットテンプレート処理により
 *   出力が途中で打ち切られるケースがある。本関数はI/O境界で構造的完了性を検査し、
 *   不完全と判定された場合にハーネス側で継続要求できるようにする。
 *
 * 検出対象:
 *   - 未閉じコードブロック (``` のペアが奇数)
 *   - 未閉じマークダウンテーブル行 (| で始まり | で終わらない)
 *   - 節の途中で終端 (末尾がカンマ/コロン/セミコロン)
 *   - 未閉じ開き括弧 ([, (, 「, 『, {, 【)
 *   - 単語/文の途中で終端 (末尾が英数字またはUnicode文字)
 *
 * 完了とみなす終端:
 *   - 文末記号 (. 。 ! ? ！ ？)
 *   - 閉じ括弧/引用 () 」 』 ] 】 } ｝ " ' …)
 *   - コードフェンス (```)
 */
export interface IncompletenessResult {
  incomplete: boolean;
  reason?: string;
}

export function isStructurallyIncomplete(text: string): IncompletenessResult {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return { incomplete: false };

  // 1. 未閉じコードブロック
  const codeFences = (trimmed.match(/```/g) ?? []).length;
  if (codeFences % 2 !== 0) {
    return { incomplete: true, reason: "未閉じコードブロック" };
  }

  // 2. 未閉じマークダウンテーブル行
  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1];
  if (lastLine.length > 1 && lastLine.startsWith("|") && !lastLine.endsWith("|")) {
    return { incomplete: true, reason: "未閉じマークダウンテーブル行" };
  }

  // 3. 末尾文字による判定
  if (trimmed.endsWith("```")) {
    return { incomplete: false };
  }

  const last = trimmed.slice(-1);

  // 妥当な終端記号
  if (/[.。!！?？)）\]】}｝"'」』…>]/.test(last)) {
    return { incomplete: false };
  }

  // 節の途中で終端
  if (/[,、:：;；]/.test(last)) {
    return { incomplete: true, reason: "節の途中で終端" };
  }

  // 未閉じ開き括弧
  if (/[[（(「『{【]/.test(last)) {
    return { incomplete: true, reason: "未閉じ開き括弧" };
  }

  // 英数字/Unicode文字で終端 (単語途中)
  if (/[\p{L}\p{N}]/u.test(last)) {
    return { incomplete: true, reason: "単語/文の途中で終端" };
  }

  // その他の記号 (-, *, #, / など) は意図的な終端または装飾の可能性があるため保守的に完了扱い
  return { incomplete: false };
}
