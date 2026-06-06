/**
 * OS-level process sandbox for bash tool execution.
 *
 * Claude Code と同等の仕組み:
 * - Linux: unshare(1) によるネットワーク名前空間隔離、bwrap(1) があればファイルシステム隔離も
 * - macOS: sandbox-exec(1) による sandbox-d プロファイル適用
 * - Windows: 未サポート（ネイティブは封じ込め無し。封じ込めが要る場合は WSL2 内で起動 →
 *   platform=linux となりこの Linux 経路が効く。docs/wsl-sandbox-design.md §3）
 * - フォールバック: ツール非存在時は設定に警告を出して no-op
 *
 * レベル設計は「FS 書込」と「ネットワーク」の2軸（docs/wsl-sandbox-design.md §7）:
 * - "fs"   : FS 書込のみ隔離・ネットワークは allowlist 経由のみ（macOS / Linux は socat+ip 時）。
 *            開発作業 (npm/pip 等) を止めない "のびのび" 向け
 * - "network": ネットワークのみ隔離・FS は開放（macOS=Seatbelt で file-write 全許可＋network deny、
 *            Linux=unshare --net）。 FS とネットを直交軸として揃えた（§7）
 * - "full" : 両方隔離
 * ネットワークの「ドメイン allowlist（プロキシ）」は Phase 2b で実装済み
 *（macOS=Seatbelt+在プロセスproxy / Linux=bwrap+socat ブリッジ。docs §7.1/§7.2）。
 */

import { existsSync, writeFileSync, realpathSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir, platform } from "node:os";

/**
 * パスを実体パスへ正規化する（symlink 解決）。 macOS/Linux のサンドボックスは正規化後の
 * 実パスで照合するため、 /tmp(→/private/tmp) 等の symlink を渡すと allow/deny が一致しない。
 * 存在しない/解決不能なパスは元の文字列を返す。
 */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export type ProcessSandboxLevel =
  | "none"        // OS-level sandboxing なし（アプリレベルのみ）
  | "fs"          // ファイルシステム書込のみ隔離（ネットワークは許可）
  | "network"     // ネットワーク名前空間隔離のみ
  | "full";       // ネットワーク + ファイルシステム隔離（bwrap / sandbox-exec が必要）

// ProcessSandboxConfig は config/types.ts を正典とする（型の二重定義による drift を防止）。
export type { ProcessSandboxConfig } from "../config/types.js";
import type { ProcessSandboxConfig } from "../config/types.js";

export interface WrappedCommand {
  shell: string;
  args: string[];
  /** 実行後に削除すべき一時ファイル（sandbox profile等） */
  cleanup?: () => void;
}

export interface SandboxAvailability {
  platform: string;
  level: ProcessSandboxLevel;
  tools: {
    bwrap: boolean;
    unshare: boolean;
    sandboxExec: boolean;
    socat: boolean;
    ip: boolean;
  };
  /** fs レベルでネット allowlist を強制できるか（macOS=常に, Linux=socat+ip 必要） */
  netAllowlistEnforceable: boolean;
  effectiveLevel: ProcessSandboxLevel;
}

/**
 * 前回までの実行で残った一時成果物（Seatbelt プロファイル・proxy unix ソケット）を掃除する。
 * 生きているプロセスのもの（pid 生存）と自プロセスのものは消さない（並行起動を壊さない）。
 * 起動時に best-effort で1回呼ぶ。
 */
export function cleanupStaleSandboxArtifacts(): void {
  const dir = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const m = /^lllm-(?:sandbox|proxy)-(\d+)/.exec(name);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 0); // 生きていれば例外なし → 残骸ではないのでスキップ
      continue;
    } catch {
      /* ESRCH 等 = プロセス不在 → 残骸として掃除 */
    }
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * processSandbox 設定の enabled / level を更新しつつ、 他フィールド（allowedHosts・
 * autoAllowBashWhenContained 等）を保持する。 `/sandbox on|off` で全置換して allowlist や
 * opt-out が無言で消える事故を防ぐ（単一窓口・テスト可能）。
 */
export function withSandboxState(
  prev: ProcessSandboxConfig | undefined,
  enabled: boolean,
  level?: ProcessSandboxLevel,
): ProcessSandboxConfig {
  const base: ProcessSandboxConfig = prev ?? { enabled: false, level: "none" };
  return { ...base, enabled, ...(level ? { level } : {}) };
}

/** ツール存在チェック（複数パスを試す） */
function findTool(...paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 既定で読み取りを塞ぐ機密ディレクトリ（decision 3: 厳しめ）。 home 相対の絶対パスを返す。
 * 全てディレクトリ（ファイル単体は含めない）。 .npmrc/.pypirc は npm/pip 認証を壊し得るので
 * あえて含めない（fs レベルは開発を止めない方針）。
 */
export function defaultSecretDenyDirs(home: string): string[] {
  return [".ssh", ".aws", ".gnupg", ".kube", ".docker", join(".config", "gcloud")].map((p) =>
    join(home, p),
  );
}

/**
 * アプリ自身の機密ディレクトリ（~/.localllm）。 クラウド LLM の API キー(config.json)・
 * 会話履歴(sessions)・チェックポイント等を含むため、 サンドボックス内 bash からの
 * 読取を遮断する（最も価値ある exfil 標的）。
 */
export function appSecretDir(home: string): string {
  return join(home, ".localllm");
}

/**
 * ~/.localllm のうち読取を戻す（allow-back）サブパス。 skills は SKILL スクリプト実行のため
 * 読める必要がある。 遮断は config/sessions/checkpoints 等に効かせつつ skills だけ通す。
 */
export function appSecretReadBackDirs(home: string): string[] {
  return [join(home, ".localllm", "skills")];
}

/**
 * bwrap 引数を組み立てる純粋関数（テスト容易化のため分離）。
 * @param command    実行するシェルコマンド
 * @param writeDirs  書込許可ディレクトリ（呼び出し側で存在チェック済みのものを渡す）
 * @param unshareNet ネットワーク名前空間を分離するか（full=true / fs=false）
 * @param maskDirs   空 tmpfs で覆って読めなくする機密ディレクトリ（呼び出し側で存在チェック済み）
 */
export function buildBwrapArgs(
  command: string,
  writeDirs: string[],
  unshareNet: boolean,
  maskDirs: string[] = [],
  readBackDirs: string[] = [],
): string[] {
  const args: string[] = [
    // Read-only bind mount of root filesystem
    "--ro-bind", "/", "/",
    // Essential virtual filesystems
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    // New session (prevents ptrace from parent)
    "--new-session",
  ];
  // ネットワーク隔離は full のみ。 fs はネットを通す（npm install 等を止めないため）
  if (unshareNet) args.push("--unshare-net");
  // Writable bind mounts for allowed directories
  for (const dir of writeDirs) {
    args.push("--bind", dir, dir);
  }
  // 機密ディレクトリを空 tmpfs で覆う（writeDirs の後に置くことで、 親が書込 bind されても確実に隠す）
  for (const dir of maskDirs) {
    args.push("--tmpfs", dir);
  }
  // tmpfs で覆った後に、 読取を戻すサブパスを ro-bind で再露出（例: ~/.localllm/skills）
  for (const dir of readBackDirs) {
    args.push("--ro-bind", dir, dir);
  }
  args.push("--", "/bin/sh", "-c", command);
  return args;
}

/**
 * Linux/WSL2 で「FS 書込スコープ + ネット allowlist 強制」の bwrap 引数を組み立てる純粋関数（2b-2）。
 * docs/wsl-sandbox-design.md §7.1。
 *
 * 方式: `--unshare-net` でネット名前空間を隔離（直接外部到達を遮断）し、 ホストの在プロセス
 * プロキシが待ち受ける unix ソケットを名前空間内へ bind-mount。 名前空間内で
 *   - `ip link set lo up`（loopback を起こす。 socat の 127.0.0.1 bind に必要）
 *   - `socat TCP-LISTEN:port,...,bind=127.0.0.1 UNIX-CONNECT:socket`（127.0.0.1:port → ソケット中継）
 * を起動し、 子の HTTP(S)_PROXY=127.0.0.1:port（bash.ts が注入）でプロキシ経由を強制する。
 * macOS の Seatbelt と同等の「proxy 経由のみ・直結遮断」を Linux でも実現する。
 *
 * @param port socat が名前空間内で待ち受ける TCP ポート（= 子 env の HTTP_PROXY ポート）
 * @param socketPath ホスト側プロキシの unix ソケット（名前空間内へ同一パスで bind 済み前提）
 * @param socatPath / ipPath 実バイナリパス
 */
export function buildBwrapAllowlistArgs(
  command: string,
  writeDirs: string[],
  maskDirs: string[],
  socketPath: string,
  port: number,
  socatPath: string,
  ipPath: string,
  readBackDirs: string[] = [],
): string[] {
  const args: string[] = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--new-session",
    "--unshare-net", // ネット隔離（直結遮断）。 通信は socat→unix ソケット→ホストproxy のみ
  ];
  for (const dir of writeDirs) args.push("--bind", dir, dir);
  for (const dir of maskDirs) args.push("--tmpfs", dir);
  // tmpfs で覆った後に、 読取を戻すサブパスを ro-bind で再露出（例: ~/.localllm/skills）
  for (const dir of readBackDirs) args.push("--ro-bind", dir, dir);
  // unix ソケットを名前空間内へ（--tmpfs /tmp の後に置き、 /tmp 配下でもマスクされず露出させる）
  args.push("--bind", socketPath, socketPath);
  // 名前空間内: lo を起こし socat を background 起動 → listen 確立を待ってからユーザーコマンド実行。
  // readiness 待ちが無いと、 socat が listen する前に最初のリクエストが ECONNREFUSED で
  // 非決定的に失敗する（レビュー C-1）。 socat 自身で接続確認し最大 ~5s 待つ。
  const bridge =
    `${ipPath} link set lo up 2>/dev/null; ` +
    `${socatPath} TCP-LISTEN:${port},fork,reuseaddr,bind=127.0.0.1 UNIX-CONNECT:${socketPath} >/dev/null 2>&1 & ` +
    `__lllm_socat=$!; __lllm_i=0; ` +
    `while [ $__lllm_i -lt 100 ]; do ` +
    `${socatPath} -u OPEN:/dev/null TCP:127.0.0.1:${port},connect-timeout=1 >/dev/null 2>&1 && break; ` +
    `__lllm_i=$((__lllm_i+1)); sleep 0.05; done; ` +
    `{ ${command}; }; __lllm_rc=$?; kill $__lllm_socat 2>/dev/null; exit $__lllm_rc`;
  args.push("--", "/bin/sh", "-c", bridge);
  return args;
}

/**
 * macOS sandbox-exec (Seatbelt) プロファイルを組み立てる純粋関数。
 * "deny default" から必要な許可を足すホワイトリスト方式。
 * FS とネットを独立2軸として扱う（docs/wsl-sandbox-design.md §7）:
 * - FS 隔離は "fs"/"full" のみ（file-write を writeDirs に限定＋機密 read 遮断）。
 *   "network" は FS 非隔離＝file-write 全許可（ネットだけ閉じる。 Linux の unshare --net と挙動を揃える）。
 * - network は "fs"(+proxyPort) のみ proxy 経由許可。 "network"/"full" は deny default のまま。
 */
export function buildSeatbeltProfile(
  writeDirs: string[],
  level: ProcessSandboxLevel,
  denyReadDirs: string[] = [],
  proxyPort?: number,
  allowReadDirs: string[] = [],
): string {
  const fsIsolated = level === "fs" || level === "full";
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    // プロセス実行は許可（シェル、コマンドを動かすために必要）
    "(allow process*)",
    // システムコール基盤
    "(allow sysctl-read)",
    "(allow signal (target self))",
    // 読み取りは全ディレクトリで許可（FS 隔離レベルでは機密のみ後段で deny override）
    "(allow file-read*)",
  ];

  if (!fsIsolated) {
    // network レベル: FS は隔離しない（ネットだけ閉じる）。 書込を全許可。
    lines.push("(allow file-write*)");
  } else {
    // fs / full: 書込を /dev /tmp と writeDirs に限定
    lines.push(`(allow file-write* (subpath "/dev"))`);
    lines.push(`(allow file-write* (subpath "/tmp"))`);
    lines.push(`(allow file-write* (subpath "/private/tmp"))`);
    for (const dir of writeDirs) {
      lines.push(`(allow file-write* (subpath "${dir}"))`);
    }
    // 機密ディレクトリは読み取りも禁止（decision 3）。 allow file-read* の後に置くことで
    // Seatbelt の last-match-wins で当該 subpath だけ deny に上書きされる。
    for (const dir of denyReadDirs) {
      lines.push(`(deny file-read* (subpath "${dir}"))`);
    }
    // 読取を戻すサブパス（例: ~/.localllm/skills）。 deny の後に置き last-match-wins で再許可。
    for (const dir of allowReadDirs) {
      lines.push(`(allow file-read* (subpath "${dir}"))`);
    }
  }

  // ネットワーク: fs のみ・かつ「プロキシ経由」のみ許可。 network/full は deny default のまま。
  // proxyPort 指定時は localhost:port（= 在プロセスプロキシ）への outbound だけ許可し直接接続を塞ぐ。
  // 【重要】Seatbelt の remote ip はホストに数値IPを受け付けず "localhost" / "*" のみ
  //   （数値 "127.0.0.1:port" を書くと sandbox-exec がプロファイルをロードせず exit 65 で全滅する）。
  //   一方、子プロセスへ注入する env は http://127.0.0.1:port のままでよい
  //   ―― rule="localhost" でも数値 127.0.0.1 への接続は許可されることを macOS 実機で確認済み
  //   （docs/wsl-sandbox-design.md §7.1 実機検証）。
  // proxyPort が無い fs は **fail-closed でネット遮断**（旧来の (allow network*) には退避しない）。
  // ＝プロキシ起動失敗・未構成でも「ネット全開」に落ちない（fail-open 防止）。
  // deny default が TCP 直結・UDP(DNS含む)・ICMP を全て覆うことも実機で確認済み（§7.1）。
  if (level === "fs" && proxyPort) {
    lines.push(`(allow network-outbound (remote ip "localhost:${proxyPort}"))`);
  }

  return lines.join("\n") + "\n";
}

/**
 * OS-level プロセスサンドボックス。
 * bash ツールの spawn() 呼び出し前に wrapCommand() を適用することで
 * カーネルレベルの隔離を追加する。
 */
export class ProcessSandbox {
  private readonly plat: string;
  private readonly bwrap: string | null;
  private readonly unshare: string | null;
  private readonly sandboxExec: string | null;
  /** Linux ネット allowlist ブリッジ用（2b-2）: socat / ip が無いと fs のネット強制不可 */
  private readonly socat: string | null;
  private readonly ip: string | null;

  constructor(private readonly config: ProcessSandboxConfig) {
    this.plat = platform();
    this.bwrap = findTool("/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap");
    this.unshare = findTool("/usr/bin/unshare", "/bin/unshare");
    this.sandboxExec = findTool("/usr/bin/sandbox-exec");
    this.socat = findTool("/usr/bin/socat", "/bin/socat", "/usr/local/bin/socat");
    this.ip = findTool("/usr/bin/ip", "/bin/ip", "/sbin/ip");
  }

  /** Linux で fs のネット allowlist を強制できるか（socat + ip が必要・2b-2）。 */
  canEnforceLinuxNetAllowlist(): boolean {
    return this.plat === "linux" && !!this.bwrap && !!this.socat && !!this.ip;
  }

  /** 有効化されているか、かつ利用可能なツールがあるか */
  isActive(): boolean {
    if (!this.config.enabled || this.config.level === "none") return false;
    return this.getEffectiveLevel() !== "none";
  }

  /** 設定と利用可能ツールから実際に適用されるレベルを返す */
  getEffectiveLevel(): ProcessSandboxLevel {
    if (!this.config.enabled || this.config.level === "none") return "none";

    if (this.plat === "linux") {
      // fs / full は FS 隔離に bwrap が必須
      if (this.config.level === "fs") return this.bwrap ? "fs" : "none";
      if (this.config.level === "full") {
        if (this.bwrap) return "full";
        return this.unshare ? "network" : "none"; // FS 隔離不可なら最低限ネット隔離へ降格
      }
      // network レベル
      return this.unshare ? "network" : "none";
    }

    if (this.plat === "darwin") {
      if (!this.sandboxExec) return "none";
      if (this.config.level === "fs") return "fs";
      if (this.config.level === "full") return "full";
      return "network";
    }

    return "none"; // Windows ネイティブは未サポート
  }

  /** 利用可能ツールの状態を返す（sandbox_info ツール用） */
  getAvailability(): SandboxAvailability {
    return {
      platform: this.plat,
      level: this.config.level,
      tools: {
        bwrap: !!this.bwrap,
        unshare: !!this.unshare,
        sandboxExec: !!this.sandboxExec,
        socat: !!this.socat,
        ip: !!this.ip,
      },
      netAllowlistEnforceable: this.plat === "darwin" ? !!this.sandboxExec : this.canEnforceLinuxNetAllowlist(),
      effectiveLevel: this.getEffectiveLevel(),
    };
  }

  /**
   * コマンドをサンドボックスでラップした spawn 引数を返す。
   * @param command  実行するシェルコマンド文字列
   * @param allowedWriteDirs  書き込みを許可するディレクトリ
   */
  wrapCommand(
    command: string,
    allowedWriteDirs: string[],
    proxyPort?: number,
    socketPath?: string,
    failClosedNet?: boolean,
  ): WrappedCommand {
    const effective = this.getEffectiveLevel();

    if (effective === "none") {
      return { shell: "/bin/sh", args: ["-c", command] };
    }

    if (this.plat === "linux") {
      return this.wrapLinux(command, allowedWriteDirs, effective, proxyPort, socketPath, failClosedNet);
    }

    if (this.plat === "darwin") {
      return this.wrapMacOS(command, allowedWriteDirs, effective, proxyPort);
    }

    return { shell: "/bin/sh", args: ["-c", command] };
  }

  /**
   * 読取遮断する機密ディレクトリ（OS 機密 + 自アプリ ~/.localllm）と、 戻すサブパス(skills)。
   * 存在するものだけを realpath 正規化して返す。
   */
  private computeSecretProtection(): { deny: string[]; allowBack: string[] } {
    const home = homedir();
    const deny = [...defaultSecretDenyDirs(home), appSecretDir(home)]
      .filter((d) => existsSync(d))
      .map(realpathSafe);
    const allowBack = appSecretReadBackDirs(home).filter((d) => existsSync(d)).map(realpathSafe);
    return { deny, allowBack };
  }

  // ── Linux ────────────────────────────────────────────────────────────────

  private wrapLinux(
    command: string,
    writeDirs: string[],
    level: ProcessSandboxLevel,
    proxyPort?: number,
    socketPath?: string,
    failClosedNet?: boolean,
  ): WrappedCommand {
    // fs / full は bwrap で FS 隔離
    if ((level === "fs" || level === "full") && this.bwrap) {
      const existing = writeDirs.filter((d) => existsSync(d)).map(realpathSafe);
      const { deny: masks, allowBack: readBack } = this.computeSecretProtection();
      // fs + プロキシ + socat/ip があれば「ネット allowlist 強制」経路（2b-2）。
      if (level === "fs" && proxyPort && socketPath && this.socat && this.ip) {
        const args = buildBwrapAllowlistArgs(
          command, existing, masks, socketPath, proxyPort, this.socat, this.ip, readBack,
        );
        return { shell: this.bwrap, args };
      }
      // ブリッジ構築失敗時(failClosedNet)は fs でもネット全遮断に倒す（fail-closed）。
      // それ以外は full=遮断 / fs=許可（allowlist 未強制。 /status が「未強制」と表示）。
      const unshareNet = level === "full" || failClosedNet === true;
      const args = buildBwrapArgs(command, existing, unshareNet, masks, readBack);
      return { shell: this.bwrap, args };
    }
    // network レベル（または full でも bwrap なしの降格）
    return this.wrapWithUnshare(command);
  }

  private wrapWithUnshare(command: string): WrappedCommand {
    // --net: ネットワーク名前空間の新規作成（ループバックのみ）
    return {
      shell: this.unshare!,
      args: ["--net", "--fork", "--", "/bin/sh", "-c", command],
    };
  }

  // ── macOS ────────────────────────────────────────────────────────────────

  private wrapMacOS(
    command: string,
    writeDirs: string[],
    level: ProcessSandboxLevel,
    proxyPort?: number
  ): WrappedCommand {
    const realWrite = writeDirs.map(realpathSafe);
    const { deny: masks, allowBack } = this.computeSecretProtection();
    const profile = buildSeatbeltProfile(realWrite, level, masks, proxyPort, allowBack);

    // 一時プロファイルは 0700 のディレクトリ内に作成（共有 /tmp に推測可能名で晒さない）。
    const dir = mkdtempSync(join(tmpdir(), "lllm-sandbox-"));
    const profilePath = join(dir, "profile.sb");
    writeFileSync(profilePath, profile, { encoding: "utf-8", mode: 0o600 });

    return {
      shell: this.sandboxExec!,
      args: ["-f", profilePath, "/bin/sh", "-c", command],
      cleanup: () => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      },
    };
  }
}
