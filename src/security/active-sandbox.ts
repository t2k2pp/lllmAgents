/**
 * 現在有効な ProcessSandbox / その設定の単一ソース（キャッシュ）。
 *
 * これまで bash.ts はキャッシュした ProcessSandbox を、 containment.ts は毎回 loadConfig()
 * から都度生成した別インスタンスを見ており、「封じ込めの実体」と「自動許可の判定根拠」が
 * 別ソースになっていた（安全判断の根拠が二重）。ここに集約し、 bash 実行・確認自動許可・
 * /sandbox 表示が全て同一の状態を参照する。docs/wsl-sandbox-design.md §7.2。
 *
 * 設定変更時は resetActiveProcessSandbox() で破棄（/sandbox on|off 等が呼ぶ）。
 */

import { ProcessSandbox, type ProcessSandboxConfig } from "./process-sandbox.js";
import { loadConfig } from "../config/config-manager.js";

let cachedSandbox: ProcessSandbox | null = null;
let cachedConfig: ProcessSandboxConfig | null = null;

function load(): ProcessSandboxConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig().security.processSandbox ?? { enabled: false, level: "none" };
  }
  return cachedConfig;
}

/** 現在有効な ProcessSandbox（初回 or reset 後に config から生成しキャッシュ）。 */
export function getActiveProcessSandbox(): ProcessSandbox {
  if (!cachedSandbox) cachedSandbox = new ProcessSandbox(load());
  return cachedSandbox;
}

/** 現在有効な processSandbox 設定（同一キャッシュ）。 */
export function getActiveSandboxConfig(): ProcessSandboxConfig {
  return load();
}

/** 設定変更時にキャッシュを破棄する（次回参照で再生成）。 */
export function resetActiveProcessSandbox(): void {
  cachedSandbox = null;
  cachedConfig = null;
}
