/**
 * 更新通知 (docs/production-readiness.md PR-14)。
 *
 * 起動時に GitHub の最新リリースタグを非同期チェックし、実行中のバージョンより
 * 新しければ1行だけ知らせる。自動更新はしない (過剰)。
 *
 * 方針:
 * - オフライン・API 失敗・レート制限は黙ってスキップ (起動を邪魔しない)
 * - 対話セッション (TTY) のみ。パイプモード・CI・E2E では実行しない
 *   (出力の決定性を守り、テストごとに GitHub API を叩かない)
 * - `updateCheck.enabled: false` でオフ (既定 on)
 */
import { APP_VERSION } from "../version.js";

const RELEASES_API = "https://api.github.com/repos/t2k2pp/lllmAgents/releases/latest";
const RELEASES_PAGE = "https://github.com/t2k2pp/lllmAgents/releases";
const FETCH_TIMEOUT_MS = 3_000;

/** "v1.2.3" / "1.2.3" を [1,2,3] に。パースできなければ null */
export function parseSemver(tag: string): [number, number, number] | null {
  const m = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a > b なら true (semver 比較) */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

/**
 * 最新リリースを調べ、更新があれば通知文を返す。無ければ null。
 * ネットワーク・API の失敗はすべて null (黙ってスキップ)。
 */
export async function checkForUpdate(currentVersion: string = APP_VERSION): Promise<string | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string };
    const latest = body.tag_name;
    if (!latest || !isNewerVersion(latest, currentVersion)) return null;
    return `新しいバージョン ${latest} が公開されています (現在 v${currentVersion})。${RELEASES_PAGE}`;
  } catch {
    return null;
  }
}
