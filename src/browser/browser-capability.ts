import * as fs from "node:fs";
import type { Config } from "../config/types.js";
import { resolvePlaywright } from "./playwright-manager.js";

/**
 * ブラウザ機能 (browser_* / game_smoke) の利用可否。
 * 「試して失敗を繰り返す」を避けるため、起動時に一度だけ判定し、未準備ならツールを登録しない。
 * docs/exe-playwright-externalization.md §B（capability ゲート）
 */
export interface BrowserCapability {
  /** ツールを登録してよいか */
  ready: boolean;
  /** 無効/有効の理由（ユーザー・エージェントへの説明用） */
  reason: string;
  /** どう決まったか（auto プローブ / 強制 on / 強制 off） */
  source: "auto" | "forced-on" | "forced-off";
}

let cached: BrowserCapability | null = null;

/** env / config による強制指定。env を優先。 */
function forcedMode(config?: Config): "on" | "off" | undefined {
  if (process.env.LOCALLLM_NO_BROWSER) return "off";
  if (process.env.LOCALLLM_FORCE_BROWSER) return "on";
  const c = config?.features?.browser;
  if (c === "off") return "off";
  if (c === "on") return "on";
  return undefined;
}

/**
 * playwright(JS) と chromium バイナリの有無を「起動せずに」確認する。
 * 実際にブラウザを launch しない（起動時を遅くしない）。
 */
async function probe(): Promise<{ ok: boolean; reason: string }> {
  const pw = await resolvePlaywright();
  if (!pw) {
    return { ok: false, reason: "Playwright(JS) が未導入です（`localllm --install-browser` で有効化）" };
  }
  try {
    const exe = pw.chromium.executablePath();
    if (!exe || !fs.existsSync(exe)) {
      return {
        ok: false,
        reason: "Chromium 未導入です（`localllm --install-browser` でダウンロード）",
      };
    }
  } catch (e) {
    return {
      ok: false,
      reason: `Chromium 実行ファイルを特定できません（${e instanceof Error ? e.message : String(e)}）`,
    };
  }
  return { ok: true, reason: "Playwright + Chromium 準備済み" };
}

/**
 * ブラウザ機能の可否を判定（起動時に index.ts から一度呼ぶ）。結果はキャッシュする。
 */
export async function probeBrowserCapability(config?: Config): Promise<BrowserCapability> {
  const forced = forcedMode(config);
  if (forced === "off") {
    cached = { ready: false, reason: "設定により無効 (features.browser=off / LOCALLLM_NO_BROWSER)", source: "forced-off" };
    return cached;
  }
  if (forced === "on") {
    cached = { ready: true, reason: "設定により強制有効 (features.browser=on / LOCALLLM_FORCE_BROWSER)", source: "forced-on" };
    return cached;
  }
  const { ok, reason } = await probe();
  cached = { ready: ok, reason, source: "auto" };
  return cached;
}

/**
 * 既にプローブ済みの結果を返す（system-prompt 等から signature 変更なしで参照するため）。
 * 未プローブなら ready:false の安全側を返す。
 */
export function getBrowserCapability(): BrowserCapability {
  return cached ?? { ready: false, reason: "未プローブ", source: "auto" };
}
