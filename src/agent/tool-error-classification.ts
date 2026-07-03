/**
 * ツール失敗が「待っても直らない」恒久失敗かのヒューリスティック判定 (P4 circuit-breaker)。
 *
 * 位置づけ: best-effort。 我々が制御する権限拒否は `ToolResult.errorKind="permanent"` で
 * 構造化済みなので、 ここでは主に **外部由来 (HTTP 401/403 等)** のエラー文字列を拾う補助。
 * 文言一致のため取りこぼしはありうるが、 **誤判定はリトライ回数が増える方向 (= 安全側) に倒れる**
 * だけで、 恒久失敗を一過性と誤れば最大 STUCK_ABORT_THRESHOLD 回で打ち切られる。 一過性を恒久と
 * 誤っても early abort で正直報告されるだけ。 いずれも silent な握り潰しは起きない。
 */

/** 恒久失敗らしいエラー文字列か (401/403/認証/権限系)。 */
export function isLikelyPermanentToolError(error: string | undefined): boolean {
  const e = (error ?? "").toLowerCase();
  if (!e) return false;
  return /\b401\b|\b403\b|invalid webhook token|unauthorized|forbidden|認証|権限確認がタイムアウト|permission denied/.test(
    e,
  );
}
