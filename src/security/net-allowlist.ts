/**
 * ネットワーク allowlist（ドメイン許可リスト）の照合と既定値。
 * docs/wsl-sandbox-design.md §7.1（Phase 2b）。
 *
 * Phase 2b の土台。 サンドボックス内の bash がアクセスできるドメインを制御するための
 * 純粋ロジック（照合・正規化・既定リスト）。 プロキシ本体や OS 配線は別モジュールで行う。
 *
 * 保存先は config の `security.processSandbox.allowedHosts`（既存フィールドを流用）。
 */

import { isIP } from "node:net";

/**
 * 既定で許可するドメイン（開発定番）。 npm / yarn / pip / GitHub。
 * これにより `/sandbox on`（fs）直後でも npm install / pip / git clone が通る。
 * 余計なものは入れない最小セット。
 */
export const DEFAULT_ALLOWED_DOMAINS: string[] = [
  // npm / yarn / pnpm（registry + CDN リダイレクト先まで包含）
  "*.npmjs.org", // registry.npmjs.org / CDN を包含
  "registry.yarnpkg.com",
  // Python（pip）。 pypi.org は完全一致、 ホイール CDN は *.pythonhosted.org で包含
  "pypi.org",
  "*.pythonhosted.org", // files.pythonhosted.org / CDN を包含
  // GitHub（git clone / submodule / raw / release tarball）
  "github.com",
  "codeload.github.com",
  "*.githubusercontent.com", // raw./objects./avatars. などを包含
  // Node 本体・prebuilt（node-gyp 等が参照）
  "nodejs.org",
];

/** 文字列に非ASCII文字が含まれるか（IDN/ホモグラフ検出用。 制御文字正規表現を避ける）。 */
function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return true;
  }
  return false;
}

/**
 * "scheme://user@host:port/path" 等からホスト名だけを正規化して取り出す。
 * 既に host だけ・host:port でも動く。
 * - userinfo (user@) を除去（`evil.com@github.com` で認可を欺く迂回を防ぐ）
 * - IPv6 はブラケット [..] を剥がし、 ブラケット無しの多コロン表記も壊さない
 * - IDN(非ASCII) は punycode(xn--) へ変換（ホモグラフでユーザーを欺き allowlist 汚染するのを防ぐ）
 */
export function normalizeHost(hostport: string): string {
  let h = hostport.trim();
  if (!h) return "";
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // scheme:// を除去
  h = h.split(/[/?#]/)[0]; // path/query/fragment を除去
  const at = h.lastIndexOf("@"); // userinfo を除去
  if (at >= 0) h = h.slice(at + 1);

  let host: string;
  if (h.startsWith("[")) {
    const end = h.indexOf("]"); // [IPv6]:port
    host = end >= 0 ? h.slice(1, end) : h.slice(1);
  } else {
    // コロンが1個だけなら host:port とみなし :port を除去（多コロン=ブラケット無し IPv6 は温存）
    const colons = (h.match(/:/g) ?? []).length;
    if (colons === 1) h = h.replace(/:\d+$/, "");
    host = h;
  }
  host = host.toLowerCase().replace(/\.+$/, ""); // 末尾ドット(FQDN・複数も)を除去

  // 非ASCII を含むホスト名は punycode へ正規化（IP リテラルは除く）
  if (isIP(host) === 0 && hasNonAscii(host)) {
    try {
      host = new URL(`http://${host}`).hostname;
    } catch {
      /* 変換不能ならそのまま */
    }
  }
  return host;
}

/**
 * config の allowedHosts から実効 allowlist を解決する（ポリシーの単一窓口）。
 * - undefined（未設定）→ 開発定番プリセット DEFAULT_ALLOWED_DOMAINS
 * - []（明示的な空）→ 空のまま（ユーザーが意図的に全ドメインを未許可にした状態）
 */
export function resolveAllowedDomains(allowedHosts?: string[]): string[] {
  return allowedHosts ?? [...DEFAULT_ALLOWED_DOMAINS];
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
    if (raw.trim() === "*") return true; // 明示的な全許可（非推奨だが対応）
    const p = raw.trim().startsWith("*.")
      ? "*" + normalizeHost(raw.trim().slice(1)) // "*." + 正規化したサフィックス
      : normalizeHost(raw);
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
  const t = domain.trim();
  const d = t === "*" || t.startsWith("*.") ? t.toLowerCase() : normalizeHost(domain);
  if (!d) return allow;
  if (allow.some((a) => a.trim().toLowerCase() === d)) return allow;
  return [...allow, d];
}

/**
 * allowlist からドメインを除去した新しい配列を返す（正規化して比較）。
 * `/sandbox deny` 用。
 */
export function removeDomain(allow: string[], domain: string): string[] {
  const t = domain.trim();
  const d = t === "*" || t.startsWith("*.") ? t.toLowerCase() : normalizeHost(domain);
  if (!d) return allow;
  return allow.filter((a) => {
    const at = a.trim();
    const an = at === "*" || at.startsWith("*.") ? at.toLowerCase() : normalizeHost(a);
    return an !== d;
  });
}
