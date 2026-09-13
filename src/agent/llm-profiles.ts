import type { Config } from "../config/types.js";
import { isCloudProvider } from "../config/types.js";
import type { LLMProfiles } from "./system-prompt.js";

/**
 * Config からシステムプロンプト注入用の LLMProfiles を組み立てる。
 * parallelCapable は「メインとセカンドが異なるマシン/サービスで動作しているか」で判定:
 *   - セカンドLLM未設定 → undefined (並列判定不要)
 *   - 既定の逐次設定 → false
 *   - クラウド同士 → false (モデル/URLが異なっても利用枠の独立性は不明)
 *   - ローカルとクラウド → 明示的な並列設定時のみ true
 *   - ローカル同士 → 明示的な並列設定かつホストが異なる場合のみ true
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

  // 並列実行は明示設定時のみ提案する。異なるモデル名だけでは許可しない。
  if ((config.maxParallelTools ?? 1) <= 1) return { main, second, parallelCapable: false };

  let parallelCapable: boolean;
  if (isCloudProvider(sec.providerType) || isCloudProvider(config.mainLLM.providerType)) {
    // クラウド同士は同じ利用枠の可能性があるため独立と推定しない。
    parallelCapable = isCloudProvider(sec.providerType) !== isCloudProvider(config.mainLLM.providerType);
  } else {
    // ローカル同士: ホストが異なれば別マシン扱い
    const mainUrl = config.mainLLM.baseUrl ? normalizeUrl(config.mainLLM.baseUrl) : "";
    const secUrl = sec.baseUrl ? normalizeUrl(sec.baseUrl) : "";
    parallelCapable = !!mainUrl && !!secUrl && mainUrl !== secUrl;
  }

  return { main, second, parallelCapable };
}

function normalizeUrl(url: string): string {
  // ホスト単位で比較する (末尾スラッシュ、パスの揺れを吸収)
  try {
    const u = new URL(url);
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname.toLowerCase())
      ? "loopback"
      : u.hostname.toLowerCase();
  } catch {
    return "";
  }
}
