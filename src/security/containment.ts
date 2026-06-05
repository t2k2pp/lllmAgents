/**
 * 封じ込め状態の判定（Phase 3）。docs/wsl-sandbox-design.md §7.2。
 *
 * 「bash がネットワーク的に封じ込められている（= allowlist 経由のみ通信でき、 直接外部到達は
 * OS レベルで遮断されている）」かを判定する。これが真のときに限り、 permission-manager は
 * bash 実行確認を自動許可してよい（破壊的コマンド・allowlist 外通信は別途確認される）。
 *
 * security レイヤ内で完結し tools 層へは依存しない（循環依存回避）。
 */

import { ProcessSandbox } from "./process-sandbox.js";
import { getSandboxProxy } from "./sandbox-proxy.js";
import { isMacOS } from "../utils/platform.js";
import { loadConfig } from "../config/config-manager.js";

/**
 * bash がネット封じ込め下にあり、 実行確認を自動許可してよい状態か。
 * 実証済みは macOS の fs + 在プロセスプロキシ強制のみ（§7.1 実機検証）。
 * Linux/WSL2 の fs はネット全開（2b-2 未実装）なので対象外。
 */
export function isBashNetworkContained(): boolean {
  if (!isMacOS) return false; // 封じ込め実証済みは macOS のみ（Phase 3 macOS 先行）
  if (!getSandboxProxy()) return false; // プロキシ未構成 = allowlist 強制されない
  const cfg = loadConfig().security.processSandbox ?? { enabled: false, level: "none" as const };
  if (cfg.autoAllowBashWhenContained === false) return false; // オプトアウト
  return new ProcessSandbox(cfg).getEffectiveLevel() === "fs";
}
