/**
 * 更新確認と明示診断 (docs/production-readiness.md PR-14 / GAP-REL-01)。
 *
 * background通知は起動を止めないbest-effort advisory、`--check-update`は
 * state不明・壊れたreleaseを成功扱いしない明示診断として分離する。
 */
import { APP_VERSION } from "../version.js";

const RELEASES_API = "https://api.github.com/repos/t2k2pp/lllmAgents/releases/latest";
const RELEASES_PAGE = "https://github.com/t2k2pp/lllmAgents/releases";
const FETCH_TIMEOUT_MS = 3_000;

interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

export type UpdateInspection =
  | {
      status: "current";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
      detail: string;
    }
  | {
      status: "available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
      assets: Array<{ name: string; url: string }>;
      detail: string;
    }
  | {
      status: "blocked";
      currentVersion: string;
      latestVersion?: string;
      releaseUrl: string;
      detail: string;
      recovery: string;
    }
  | {
      status: "unavailable";
      currentVersion: string;
      releaseUrl: string;
      detail: string;
      recovery: string;
    };

/** "v1.2.3" / "1.2.3" を [1,2,3] に。公開版以外は null。 */
export function parseSemver(tag: string): [number, number, number] | null {
  const m = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a > b なら true (公開SemVer比較)。 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

function normalizeAssets(value: unknown): Array<{ name: string; url: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: GitHubReleaseAsset) => {
    if (typeof item?.name !== "string" || typeof item.browser_download_url !== "string") return [];
    return [{ name: item.name, url: item.browser_download_url }];
  });
}

/** GitHub releaseの状態を判定する。明示診断用なので失敗理由を捨てない。 */
export async function inspectUpdate(currentVersion: string = APP_VERSION): Promise<UpdateInspection> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        status: "unavailable",
        currentVersion,
        releaseUrl: RELEASES_PAGE,
        detail: `GitHub Releases API が HTTP ${res.status} を返したため最新版を判定できません`,
        recovery: `ネットワーク/レート制限を確認し、${RELEASES_PAGE} を直接確認してください`,
      };
    }

    const body = (await res.json()) as GitHubRelease;
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    const parsed = parseSemver(tag);
    const releaseUrl = typeof body.html_url === "string" ? body.html_url : RELEASES_PAGE;
    if (!parsed) {
      return {
        status: "blocked",
        currentVersion,
        releaseUrl,
        detail: `latest release tag ${JSON.stringify(tag || null)} は vMAJOR.MINOR.PATCH ではありません`,
        recovery: "release管理者はtag・package.json・CHANGELOGを一致させて再リリースしてください",
      };
    }

    const latestVersion = parsed.join(".");
    const assets = normalizeAssets(body.assets);
    if (assets.length === 0) {
      return {
        status: "blocked",
        currentVersion,
        latestVersion,
        releaseUrl,
        detail: `release v${latestVersion} は公開されていますが、ダウンロード可能な配布物がありません`,
        recovery: "release管理者が検証済み配布物を追加するまで、既存binaryを置換しないでください",
      };
    }

    if (!isNewerVersion(latestVersion, currentVersion)) {
      return {
        status: "current",
        currentVersion,
        latestVersion,
        releaseUrl,
        detail: `最新版 v${latestVersion} を使用しています (buildは --version で確認)`,
      };
    }

    return {
      status: "available",
      currentVersion,
      latestVersion,
      releaseUrl,
      assets,
      detail: `更新 v${latestVersion} が利用できます (現在 v${currentVersion}、配布物 ${assets.length} 件)`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      currentVersion,
      releaseUrl: RELEASES_PAGE,
      detail: `最新版を判定できません: ${reason}`,
      recovery: `ネットワークを確認し、${RELEASES_PAGE} を直接確認してください`,
    };
  }
}

export function formatUpdateInspection(result: UpdateInspection, options: { json?: boolean } = {}): string {
  if (options.json) return JSON.stringify(result);
  const lines = [`[check-update] ${result.status.toUpperCase()} — ${result.detail}`, `  ${result.releaseUrl}`];
  if ("recovery" in result) lines.push(`  対処: ${result.recovery}`);
  if (result.status === "available") lines.push(`  配布物: ${result.assets.map((asset) => asset.name).join(", ")}`);
  return lines.join("\n");
}

/** TTY起動中のbest-effort通知。到達不能は起動ノイズにせず、壊れた公開releaseは隠さない。 */
export async function checkForUpdate(currentVersion: string = APP_VERSION): Promise<string | null> {
  const result = await inspectUpdate(currentVersion);
  if (result.status === "available") return `${result.detail}。${result.releaseUrl}`;
  if (result.status === "blocked") return `${result.detail}。対処: ${result.recovery}。${result.releaseUrl}`;
  return null;
}
