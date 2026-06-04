/**
 * WSL (Windows Subsystem for Linux) 検出。
 * docs/wsl-sandbox-design.md 参照。
 *
 * 用途は「検出」のみ。 Windows ネイティブで本アプリを動かしている時に、
 * 「WSL2 があるなら、 その中でアプリを起動すれば Linux サンドボックス
 * (processSandbox: bwrap) で bash を封じ込められます」とユーザーへ案内するために使う。
 *
 * 注: かつては「bash だけ wsl.exe 経由で WSL に流す」routing も実装していたが
 * (復帰点タグ: wsl-phase1-routing)、 Windows を「ネイティブ / WSL2 内起動」の 2 種に
 * 整理した際に退役した。 WSL2 内で起動すれば platform=linux となり既存の Linux
 * サンドボックス経路がそのまま効くため、 専用の routing コードは不要 (docs §3・§4.6)。
 */

import { execFileSync } from "node:child_process";
import { isWindows } from "../utils/platform.js";

export interface WslDetection {
  /** wsl.exe が存在し --status が成功したか */
  available: boolean;
  /** default distro が WSL2 か（WSL1 は bwrap 不可なので区別する） */
  wsl2: boolean;
  /** default distro 名（取得できなければ null） */
  defaultDistro: string | null;
}

/**
 * `wsl -l -v` の出力から default distro 名と WSL2 か否かを解析する。
 * 出力例（先頭の * が default、 末尾列が VERSION）:
 *   "  NAME      STATE     VERSION"
 *   "* Ubuntu    Running   2"
 *
 * UTF-16LE 由来の NUL バイトは decodeWslOutput で除去済みの前提だが念のため除去する。
 */
export function parseWslList(out: string | null): {
  defaultDistro: string | null;
  wsl2: boolean;
} {
  if (!out) return { defaultDistro: null, wsl2: false };
  const lines = out.split(/\r?\n/).map((l) => l.replace(/\0/g, "").trimEnd());
  for (const raw of lines) {
    const line = raw.trimStart();
    if (!line.startsWith("*")) continue; // default distro 行のみ
    const cols = line.slice(1).trim().split(/\s+/).filter(Boolean);
    if (cols.length === 0) return { defaultDistro: null, wsl2: false };
    const name = cols[0] ?? null;
    const ver = cols[cols.length - 1];
    return { defaultDistro: name, wsl2: ver === "2" };
  }
  return { defaultDistro: null, wsl2: false };
}

/** wsl.exe の出力は UTF-16LE のことが多い。 NUL バイトの有無で判定してデコードする。 */
function decodeWslOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf.includes(0)) return buf.toString("utf16le");
  return buf.toString("utf8");
}

function runWsl(args: string[]): string | null {
  try {
    const buf = execFileSync("wsl.exe", args, {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return decodeWslOutput(buf as Buffer);
  } catch {
    return null;
  }
}

let cachedDetection: WslDetection | undefined;

/** WSL の検出。 プロセス内でキャッシュする。 非 Windows では常に available:false。 */
export function detectWsl(): WslDetection {
  if (cachedDetection !== undefined) return cachedDetection;

  if (!isWindows) {
    cachedDetection = { available: false, wsl2: false, defaultDistro: null };
    return cachedDetection;
  }

  const status = runWsl(["--status"]);
  if (status === null) {
    cachedDetection = { available: false, wsl2: false, defaultDistro: null };
    return cachedDetection;
  }

  const { defaultDistro, wsl2 } = parseWslList(runWsl(["-l", "-v"]));
  cachedDetection = { available: true, wsl2, defaultDistro };
  return cachedDetection;
}

/** 検出キャッシュをリセットする（テスト用）。 */
export function resetWslCache(): void {
  cachedDetection = undefined;
}
