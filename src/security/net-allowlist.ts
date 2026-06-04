/**
 * ネットワーク allowlist（ドメイン許可リスト）の照合と既定値。
 * docs/wsl-sandbox-design.md §7.1（Phase 2b）。
 *
 * Phase 2b の土台。 サンドボックス内の bash がアクセスできるドメインを制御するための
 * 純粋ロジック（照合・正規化・既定リスト）。 プロキシ本体や OS 配線は別モジュールで行う。
 *
 * 保存先は config の `security.processSandbox.allowedHosts`（既存フィールドを流用）。
 */

/**
 * 既定で許可するドメイン（開発定番）。 npm / yarn / pip / GitHub。
 * これにより `/sandbox on`（fs）直後でも npm install / pip / git clone が通る。
 * 余計なものは入れない最小セット。
 */
export const DEFAULT_ALLOWED_DOMAINS: string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
  "*.githubusercontent.com", // raw./objects./avatars. などを包含
];

/**
 * "scheme://host:port/path" 等からホスト名だけを小文字で取り出す。
 * 既に host だけ・host:port でも動く。
 */
export function normalizeHost(hostport: string): string {
  let h = hostport.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme:// を除去
  h = h.split("/")[0]; // path を除去
  h = h.replace(/:\d+$/, ""); // :port を除去
  h = h.replace(/\.$/, ""); // 末尾ドット(FQDN)を除去し allowlist と一致させる
  // IPv6 ブラケットは今回対象外（[::1] 等はそのまま返す）
  return h;
}

/**
 * host が allowlist のいずれかに合致するか。
 * - 完全一致（example.com）
 * - ワイルドカード（*.example.com）: サブドメインのみ合致。 ベアドメインには合致しない。
 */
export function domainAllowed(host: string, allow: string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const raw of allow) {
    const p = normalizeHost(raw === "*" ? "*" : raw); // "*" は normalize で空になるので別扱い
    if (raw.trim() === "*") return true; // 明示的な全許可（非推奨だが対応）
    if (!p) continue;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (p === h) {
      return true;
    }
  }
  return false;
}

/**
 * allowlist にドメインを追加した新しい配列を返す（重複・正規化を考慮）。
 * ワイルドカードや "*" はそのまま保持する。
 */
export function addDomain(allow: string[], domain: string): string[] {
  const d = domain.trim() === "*" || domain.trim().startsWith("*.")
    ? domain.trim().toLowerCase()
    : normalizeHost(domain);
  if (!d) return allow;
  if (allow.some((a) => a.trim().toLowerCase() === d)) return allow;
  return [...allow, d];
}
