/**
 * 封じ込め状態の判定（Phase 3）。docs/wsl-sandbox-design.md §7.2。
 *
 * 「bash がネットワーク的に封じ込められている（= allowlist 経由のみ通信でき、 直接外部到達は
 * OS レベルで遮断されている）」かを判定する。これが真のときに限り、 permission-manager は
 * bash 実行確認を自動許可してよい（破壊的コマンド・allowlist 外通信は別途確認される）。
 *
 * security レイヤ内で完結し tools 層へは依存しない（循環依存回避）。
 */

import { getActiveProcessSandbox, getActiveSandboxConfig } from "./active-sandbox.js";
import { getSandboxProxy } from "./sandbox-proxy.js";
import { isMacOS } from "../utils/platform.js";

/**
 * bash がネット封じ込め下にあり、 実行確認を自動許可してよい状態か。
 * 実証済みは macOS の fs + 在プロセスプロキシ強制のみ（§7.1 実機検証）。
 * Linux/WSL2 の fs はネット全開（2b-2 未実装）なので対象外。
 */
export function isBashNetworkContained(): boolean {
  if (!isMacOS) return false; // 封じ込め実証済みは macOS のみ（Phase 3 macOS 先行）
  // プロキシ未構成なら自動許可しない。 構成済み(!=null)で十分な理由: 仮に bash 実行時に
  // ensureStarted が失敗しても bash.ts が fail-closed でネット全遮断にするため、 自動許可しても
  // exfil は起きない（安全性は proxy の稼働状態に依存しない）。 強制中か否かの厳密判定は不要。
  if (!getSandboxProxy()) return false;
  if (getActiveSandboxConfig().autoAllowBashWhenContained === false) return false; // オプトアウト
  // bash 実行と同一の単一ソースを参照（封じ込めの実体と判定根拠を一致させる）
  return getActiveProcessSandbox().getEffectiveLevel() === "fs";
}
