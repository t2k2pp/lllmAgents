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
 * 自己点検メッセージを整形する。
 *
 * @param round 現在のラウンド (1-indexed)
 * @param max 最大ラウンド数 (上限到達でターン強制終了)
 * @param intent 起点となった依頼。 メインなら user message、 サブなら delegate prompt
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
  const truncated = intent.length > 200 ? intent.slice(0, 200) + "..." : intent;
  const action =
    actionHint ??
    "追加作業が不要なら response_complete ツールを呼んでください\n" +
      "  ・作業が残っているなら該当ツールを呼んでください";
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
  "追加作業が不要なら最終回答を出してタスクを完了してください\n" +
  "  ・作業が残っているなら該当ツールを呼んでください";
