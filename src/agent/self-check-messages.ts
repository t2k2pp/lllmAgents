/**
 * 自己点検メッセージの整形 (ID-012: 2026-04-30 共通化)。
 *
 * `[自己点検 N/M]` マーカーで「ハーネス通知 (ユーザー発言ではない)」 であることを明示し、
 * LLM に自問自答を促す。 偽ユーザー発言で詰めるのではなく、 マーカー付きでハーネス起源を
 * 明確にすることで「ユーザー発話偽装の弊害」 (progress.md L321-340) を回避する。
 *
 * 旧来は agent-loop.ts に内包されていたが、 sub-agent.ts も同種の retry 経路 (continuation
 * / fake file write) を持っていたため、 重複していた。 本モジュールで共通化し、 メイン /
 * サブ両方が同じフォーマットで自己点検を出す。
 *
 * 関連: `docs/prompt-tech-debt-review.md` ID-008 / ID-012
 */

/**
 * 「沈黙系依頼」 のパターン (= ユーザーが「応答を返すな / 返事不要 / 中間報告不要」 と
 * 明示しているケース)。 こうした literal cue を [自己点検] や 空応答 nudge に逐語で
 * echo すると、 model が「沈黙すべき」 と再解釈してツール呼出を止める現象を確認
 * (2026-05-01: セッション mom9py3u-xidq で gpt-5.3-codex が turn 20-39 まで promise
 * だけ返し続ける状態に陥った)。 この場合は intent を翻訳してから提示する。
 */
const SILENT_CONTINUATION_PATTERNS: ReadonlyArray<RegExp> = [
  /応答を返さない/,
  /応答(は|を)?(不要|要らない|いらない)/,
  /返事(は|を)?(不要|要らない|いらない)/,
  /返答(は|を)?(不要|要らない|いらない)/,
  /中間報告.*(不要|要らない|いらない)/,
  /進捗報告.*(不要|要らない|いらない)/,
  /(?:^|[^一-龯])(黙って|だまって)/,
  /喋らないで|しゃべらないで/,
];

/**
 * ユーザー intent に「沈黙系依頼」 が含まれる場合、 ハーネスが内部で再提示する用に
 * 翻訳する。 該当しなければ元の intent をそのまま返す。
 *
 * 「応答を返さないで」 → 「継続的にツールを呼び、 中間報告のテキストを返さずに作業を進めてほしい」
 *
 * これは [自己点検] / 空応答 nudge / SubAgent の自己点検 すべての経路で使う共通の
 * 入力フィルタ。 元のユーザー文言は session 履歴に残っているため失われない。
 */
export function rephraseUserIntent(intent: string): string {
  if (SILENT_CONTINUATION_PATTERNS.some((p) => p.test(intent))) {
    return "継続的にツール (file_write / file_edit / bash 等) を呼び、 中間報告のテキストを返さずに完成まで作業を進めてほしい";
  }
  return intent;
}

/**
 * 自己点検メッセージを整形する。
 *
 * @param round 現在のラウンド (1-indexed)
 * @param max 最大ラウンド数 (上限到達でターン強制終了)
 * @param intent 起点となった依頼。 メインなら user message、 サブなら delegate prompt
 *               (「応答を返さないで」 等の沈黙系依頼が含まれていれば内部で翻訳される)
 * @param concern 個別の懸念事項 (例: "応答が途中で切れています。 続きを出力してください。")
 * @param actionHint 取るべき次の行動の案内文 (省略時はメイン用 = response_complete 呼出を促す)
 */
export function formatSelfCheck(
  round: number,
  max: number,
  intent: string,
  concern: string,
  actionHint?: string,
): string {
  const rephrased = rephraseUserIntent(intent);
  const truncated = rephrased.length > 200 ? rephrased.slice(0, 200) + "..." : rephrased;
  const action =
    actionHint ??
    "次の 1 手は、 依頼にふさわしい形で可視的な結果を出すこと:\n" +
      "  (a) 答えが既に出ているなら、 そのまま回答を出して完了する (メインは response_complete。 答えだけで済む依頼はテキスト回答でよい)\n" +
      "  (b) まだ作業が要るなら、 該当ツール (file_write / file_edit / bash / mcp__... 等) を呼ぶ\n" +
      "  ・中身の無い promise テキスト (「了解しました」「実装します」 等) *だけ* では進捗と認識しない (上限到達でターン終了)。 中身のある回答や実行は進捗とみなす";
  return (
    `[自己点検 ${round}/${max}] 今の応答を確認してください:\n` +
    `  ・依頼「${truncated}」 に応えていますか?\n` +
    `  ・${concern}\n` +
    `  ・${action}`
  );
}

/**
 * SubAgent 用の actionHint。 SubAgent は response_complete を呼ばず、 最終回答テキストを
 * return することで完了するため、 メイン用とは案内文が異なる。
 */
export const SUB_AGENT_ACTION_HINT =
  "追加作業が不要なら最終回答を出してタスクを完了してください\n" + "  ・作業が残っているなら該当ツールを呼んでください";
