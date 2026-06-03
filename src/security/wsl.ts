/**
 * WSL (Windows Subsystem for Linux) 連携。
 * docs/wsl-sandbox-design.md 参照。
 *
 * Windows では bash ツールを WSL 経由で実行することで、 WSL の中（= Linux）で
 * 既存の Linux サンドボックス (process-sandbox.ts の bwrap/unshare) を再利用できる。
 * これにより Windows に欠けていた「ハード層（カーネルレベルの封じ込め）」を与える。
 *
 * Phase 1: 検出 + WSL 経由実行 + パス変換 + フォールバック（隔離はまだ適用しない）。
 *
 * 純粋関数 (toWslPath / convertWindowsPathsToWsl / parseWslList / resolveWslRouting) は
 * platform / 検出結果を引数で受け取り、 クロスプラットフォームでユニットテスト可能にしている。
 */

import { execFileSync } from "node:child_process";
import { isWindows } from "../utils/platform.js";
import type { WslConfig } from "../config/types.js";

export interface WslDetection {
  /** wsl.exe が存在し --status が成功したか */
  available: boolean;
  /** default distro が WSL2 か（WSL1 は namespace 挙動が異なるため区別する） */
  wsl2: boolean;
  /** default distro 名（取得できなければ null）。null でも wsl は既定 distro で動く */
  defaultDistro: string | null;
}

export interface WslRouting {
  /** bash を WSL 経由で実行すべきか */
  use: boolean;
  /** -d に渡す distro 名（未指定なら wsl の既定 distro を使う） */
  distro?: string;
  /** use=false の理由（可視化・デバッグ用） */
  reason?: string;
}

// ── パス変換 ────────────────────────────────────────────────────────────────

/**
 * Windows 絶対パスを WSL パスへ変換する。
 *   C:\Users\foo  → /mnt/c/Users/foo
 *   D:/work/bar   → /mnt/d/work/bar
 * ドライブレターが無いパスは区切りだけスラッシュへ正規化して返す。
 */
export function toWslPath(winPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return winPath.replace(/\\/g, "/");
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, "/");
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

/**
 * コマンド文字列中の Windows スタイルのドライブパスを WSL パスへ変換する。
 *   "node C:\\app\\x.js" → "node /mnt/c/app/x.js"
 * git bash 用の convertWindowsPaths と異なり /mnt/<drive> 形式に変換する点が要点。
 *
 * 対象: ドライブレター + 区切り (\\ または /) で始まるパスのみ。
 * 非対象: 正規表現中の \\、 エスケープシーケンス、 ドライブレターを伴わない / 始まりのパス。
 */
export function convertWindowsPathsToWsl(command: string): string {
  // rest は区切り文字込みで捕捉し、 空白・引用符・シェルメタで停止する。
  // 空白を含めると "cp C:\a C:\b" の 2 つ目のドライブレターまで食ってしまうため含めない
  // （空白入りパスはシェルで引用される前提）。
  return command.replace(
    /([A-Za-z]):([\\/][^\s"'`<>|]*)/g,
    (_match, drive: string, rest: string) =>
      `/mnt/${drive.toLowerCase()}${rest.replace(/\\/g, "/")}`,
  );
}

/** シェル用に単一引用符でクォートする（パス中の空白・特殊文字対策） */
export function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── distro 一覧の解析 ────────────────────────────────────────────────────────

/**
 * `wsl -l -v` の出力から default distro 名と WSL2 か否かを解析する。
 * 出力例（先頭の * が default、 末尾列が VERSION）:
 *   "  NAME      STATE     VERSION"
 *   "* Ubuntu    Running   2"
 *   "  Debian    Stopped   2"
 *
 * UTF-16LE 由来の NUL バイトは decodeWslOutput で除去済みの前提だが、 念のためここでも除去する。
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

// ── ルーティング判定（純粋関数） ──────────────────────────────────────────────

/**
 * 設定・検出結果・プラットフォームから、 bash を WSL 経由で実行すべきかを判定する。
 * 純粋関数（副作用なし）。 platform と detection を引数で受け取るためテスト容易。
 *
 * enabled の既定は "auto": Windows かつ WSL2 検出時のみ有効。
 *   - false       → 常に従来経路
 *   - true        → WSL1 でも強制的に WSL 経路（検出はする）
 *   - "auto"/未指定 → WSL2 検出時のみ
 */
export function resolveWslRouting(
  wslConfig: WslConfig | undefined,
  detection: WslDetection,
  isWin: boolean,
): WslRouting {
  if (!isWin) return { use: false, reason: "not windows" };

  const enabled = wslConfig?.enabled ?? "auto";
  if (enabled === false) return { use: false, reason: "config で無効" };

  if (!detection.available) return { use: false, reason: "WSL 未検出" };

  if (!detection.wsl2 && enabled !== true) {
    return { use: false, reason: "WSL1 検出（enabled:true で強制可）" };
  }

  return { use: true, distro: wslConfig?.distro ?? detection.defaultDistro ?? undefined };
}

// ── 検出（副作用あり・キャッシュ） ────────────────────────────────────────────

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

/** WSL の検出。 プロセス内でキャッシュする（getGitBash と同じ遅延初期化）。 */
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

/** 検出キャッシュをリセットする（テスト・設定変更ウィザード用）。 */
export function resetWslCache(): void {
  cachedDetection = undefined;
}

/**
 * bash ツール用: WSL 経由実行の spawn 引数を組み立てる。
 * `--cd` は古い WSL で未サポートのことがあるため使わず、 コマンド先頭に cd を埋め込む。
 *
 * @param routing  resolveWslRouting の結果（use=true 前提）
 * @param command  実行するシェルコマンド（Windows パスを含み得る）
 * @param winCwd   Windows 側の作業ディレクトリ（process.cwd()）
 * @returns spawn の shell/args
 */
export function buildWslInvocation(
  routing: WslRouting,
  command: string,
  winCwd: string,
): { shell: string; args: string[] } {
  const wslCwd = toWslPath(winCwd);
  const converted = convertWindowsPathsToWsl(command);
  // login shell (-l) でユーザーの PATH（nvm 等）を可能な限り拾う。
  const inner = `cd ${singleQuote(wslCwd)} 2>/dev/null; ${converted}`;
  const args: string[] = [];
  if (routing.distro) args.push("-d", routing.distro);
  args.push("--", "bash", "-lc", inner);
  return { shell: "wsl.exe", args };
}
