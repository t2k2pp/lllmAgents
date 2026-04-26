import type { Config } from "../config/types.js";
import { isCloudProvider } from "../config/types.js";
import type { LLMProfiles } from "./system-prompt.js";

/**
 * Config からシステムプロンプト注入用の LLMProfiles を組み立てる。
 * parallelCapable は「メインとセカンドが異なるマシン/サービスで動作しているか」で判定:
 *   - セカンドLLM未設定 → undefined (並列判定不要)
 *   - クラウドセカンド → 常に true (別マシン確定)
 *   - ローカル同士 → baseUrl が異なれば true、同じなら false (GPU競合回避のため逐次推奨)
 */
export function buildLLMProfiles(config: Config, hasSecondLLM: boolean): LLMProfiles {
  const main = {
    model: config.mainLLM.model,
    providerType: config.mainLLM.providerType,
    baseUrl: config.mainLLM.baseUrl,
    description: config.mainLLM.description,
  };

  if (!hasSecondLLM || !config.secondLLM?.enabled || !config.secondLLM.endpoint) {
    return { main };
  }

  const sec = config.secondLLM.endpoint;
  const second = {
    model: sec.model,
    providerType: sec.providerType,
    baseUrl: sec.baseUrl,
    description: sec.description,
  };

  let parallelCapable: boolean;
  if (isCloudProvider(sec.providerType) || isCloudProvider(config.mainLLM.providerType)) {
    // どちらか一方でもクラウドなら別マシン扱い
    parallelCapable = true;
  } else {
    // ローカル同士: baseUrl が異なれば別マシン扱い
    const mainUrl = config.mainLLM.baseUrl ? normalizeUrl(config.mainLLM.baseUrl) : "";
    const secUrl = sec.baseUrl ? normalizeUrl(sec.baseUrl) : "";
    parallelCapable = !!mainUrl && !!secUrl && mainUrl !== secUrl;
  }

  return { main, second, parallelCapable };
}

function normalizeUrl(url: string): string {
  // ホスト+ポート単位で比較する (末尾スラッシュ、パスの揺れを吸収)
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port}`.toLowerCase();
  } catch {
    return url.trim().replace(/\/+$/, "").toLowerCase();
  }
}
