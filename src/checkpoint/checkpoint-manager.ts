import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as logger from "../utils/logger.js";
import { resolveGitExecutable } from "../git/git-command.js";

const execFileAsync = promisify(execFile);

/**
 * 自動チェックポイント (docs/checkpoint-and-smoke-design.md §4)。
 *
 * 作業フォルダを「シャドウ Git リポジトリ」で版管理する。
 * - `.git` 本体は作業フォルダの外 (`~/.localllm/checkpoints/<session-id>/`) に置く
 *   → ユーザーが同じフォルダで自分の Git を使っていても衝突しない
 *     (git-dir / index / ロック / 履歴がすべて独立、 作業フォルダに .git を作らない)
 * - モデルは関与しない。 file_write/file_edit の後にハーネスが裏でコミットする
 * - Claude Code の file-history-snapshot / `/rewind` と同コンセプト
 *
 * ON/OFF は config.checkpoints.enabled / REPL `/checkpoint` で切替 (既定 OFF のオプトイン)。
 */
export interface CheckpointEntry {
  /** 新しい順の連番 (1 = 直近) */
  n: number;
  hash: string;
  shortHash: string;
  date: string;
  message: string;
}

export interface RetentionPolicy {
  /** 保持する最大セッション数 (新しい順)。 0 で無制限 */
  maxSessions?: number;
  /** この日数より古いセッションは削除。 0 で無制限 */
  maxAgeDays?: number;
}

/** 機密ファイルの混入防止 (M3)。 作業フォルダ配下でも版管理しない */
const SECRET_EXCLUDES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "*.p12",
  "*.pfx",
];

export class CheckpointManager {
  /** ~/.localllm/checkpoints (全セッションの親) */
  private readonly root: string;
  /** チェックポイントの名前空間 (resume を跨いで安定させる = session.meta.id 推奨) */
  private sessionId: string;
  private gitDir: string;
  private readonly workTree: string;
  private enabled: boolean;
  private readonly retention?: RetentionPolicy;
  /** これを超えるファイルはステージから外す (シャドウGit肥大防止)。 0 で無制限 */
  private readonly maxFileSizeBytes: number;
  private gitAvailable: boolean | null = null;
  private gitExecutable: string | null = null;
  private initialized = false;
  /** gc --auto を間引くためのコミット数カウンタ */
  private commitCount = 0;
  /** index.lock 競合を避けるための直列化キュー */
  private queue: Promise<unknown> = Promise.resolve();
  /** 直近の commit 失敗メッセージ (status 表示用)。 成功で null に戻す */
  private lastError: string | null = null;

  constructor(opts: {
    sessionId: string;
    workTree?: string;
    enabled?: boolean;
    retention?: RetentionPolicy;
    maxFileSizeMb?: number;
  }) {
    this.root = path.join(os.homedir(), ".localllm", "checkpoints");
    this.sessionId = opts.sessionId;
    this.gitDir = path.join(this.root, opts.sessionId);
    this.workTree = opts.workTree ?? process.cwd();
    this.enabled = opts.enabled ?? false;
    this.retention = opts.retention;
    this.maxFileSizeBytes = Math.max(0, opts.maxFileSizeMb ?? 25) * 1024 * 1024;
  }

  /**
   * 版管理スコープ (work-tree) を解決する (M3)。
   * - 設定 `workTreeDir` があればそれ (cwd 相対 or 絶対)
   * - 無ければ `<cwd>/sandbox/output` が存在すればそこ (開発時に src/ や機密を撮らない)
   * - どちらも無ければ cwd (deploy exe を成果物フォルダで動かす実運用では cwd = 成果物)
   */
  static resolveWorkTree(cwd: string, configuredDir?: string): string {
    if (configuredDir && configuredDir.trim()) {
      return path.isAbsolute(configuredDir) ? configuredDir : path.resolve(cwd, configuredDir);
    }
    const artifact = path.join(cwd, "sandbox", "output");
    try {
      if (fs.statSync(artifact).isDirectory()) return artifact;
    } catch {
      /* 無ければ cwd */
    }
    return cwd;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  /** status 表示用 (有効状態 + 版管理対象フォルダ + 直近のコミット失敗) */
  getStatus(): { enabled: boolean; workTree: string; lastError: string | null } {
    return { enabled: this.enabled, workTree: this.workTree, lastError: this.lastError };
  }

  /**
   * resume 時にチェックポイントの名前空間を載せ替える (H1)。
   * 起動ごとに新規 ID で初期化された後、 復元するセッションの安定 ID に貼り替えることで、
   * プロセスを跨いだチェックポイントの継承を成立させる。
   */
  rebind(sessionId: string): void {
    if (!sessionId || sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.gitDir = path.join(this.root, sessionId);
    this.initialized = false;
    this.commitCount = 0;
  }

  /** git が利用可能か (公開・status/起動警告用)。 初回だけ実測しキャッシュ */
  async isGitReady(): Promise<boolean> {
    return this.ensureGit();
  }

  /** git コマンドが使えるか (初回だけ実測してキャッシュ) */
  private async ensureGit(): Promise<boolean> {
    if (this.gitAvailable !== null) return this.gitAvailable;
    try {
      this.gitExecutable = resolveGitExecutable();
      await execFileAsync(this.gitExecutable, ["--version"]);
      this.gitAvailable = true;
    } catch {
      this.gitAvailable = false;
      logger.debug("checkpoint: git が見つからないためチェックポイントは無効");
    }
    return this.gitAvailable;
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (!this.gitExecutable) throw new Error("checkpoint Git capability is not initialized");
    // --git-dir と --work-tree を明示することで「作業フォルダの外」 に履歴を持つ
    return execFileAsync(this.gitExecutable, [`--git-dir=${this.gitDir}`, `--work-tree=${this.workTree}`, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  private async ensureInit(): Promise<boolean> {
    if (this.initialized) return true;
    if (!(await this.ensureGit())) return false;
    try {
      fs.mkdirSync(this.gitDir, { recursive: true });
      // HEAD が無ければ init
      if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) {
        await this.git(["init", "-q"]);
        // コミット失敗を防ぐためのローカル identity
        await this.git(["config", "user.name", "lllmAgents-checkpoint"]);
        await this.git(["config", "user.email", "checkpoint@localllm.local"]);
      }
      // 巨大/不要ディレクトリ・機密を除外 (作業フォルダ内 .gitignore も併せて尊重される)
      const exclude = [
        "node_modules/",
        ".git/",
        "dist/",
        "deploy/",
        ".localllm/",
        "*.log",
        ".DS_Store",
        ...SECRET_EXCLUDES,
      ].join("\n");
      const infoDir = path.join(this.gitDir, "info");
      fs.mkdirSync(infoDir, { recursive: true });
      fs.writeFileSync(path.join(infoDir, "exclude"), exclude + "\n");
      this.initialized = true;
      return true;
    } catch (e) {
      logger.debug(`checkpoint: init 失敗 — ${String(e)}`);
      return false;
    }
  }

  /** filePath が版管理対象 (作業フォルダ配下) か */
  private inScope(filePath: string): boolean {
    try {
      const rel = path.relative(this.workTree, path.resolve(filePath));
      return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
    } catch {
      return false;
    }
  }

  /**
   * ファイル変更後の自動コミット。 対象外パス・無効時・git 無しでは黙って no-op。
   * 競合回避のため直列化する。
   */
  async commitForFile(filePath: string, message: string): Promise<void> {
    if (!this.enabled) return;
    if (!this.inScope(filePath)) return;
    this.queue = this.queue
      .then(() => this.doCommit(message))
      .catch((e) => {
        logger.debug(`checkpoint: commit 失敗 — ${String(e)}`);
      });
    await this.queue;
  }

  /** 明示コミット (復元前スナップショット等)。 戻り値はコミットしたか否か */
  async commit(message: string): Promise<boolean> {
    let committed = false;
    this.queue = this.queue
      .then(async () => {
        committed = await this.doCommit(message);
      })
      .catch((e) => {
        logger.debug(`checkpoint: commit 失敗 — ${String(e)}`);
      });
    await this.queue;
    return committed;
  }

  private async doCommit(messageHint: string): Promise<boolean> {
    if (!(await this.ensureInit())) return false;
    // add -A で作業ツリー全体をステージ → 各コミットが完全な復元可能スナップショットになる
    await this.git(["add", "-A"]);
    if (this.maxFileSizeBytes > 0) {
      await this.unstageOversized();
    }
    const staged = await this.stagedFiles();
    if (staged.length === 0) return false; // 差分なし
    const msg = this.buildMessage(messageHint, staged);
    try {
      await this.git(["commit", "-q", "-m", msg]);
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e).slice(0, 200);
      throw e;
    }
    // セッション内ストレージ圧縮: 50 コミットごとに git の自動 gc を促す (閾値未満なら no-op)
    if (++this.commitCount % 50 === 0) {
      await this.git(["gc", "--auto", "-q"]).catch(() => {});
    }
    return true;
  }

  private async stagedFiles(): Promise<string[]> {
    try {
      const { stdout } = await this.git(["diff", "--cached", "--name-only"]);
      return stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** メッセージを「変更ファイル群」 から生成 (同ターン複数ファイルでも実態を反映 / M1) */
  private buildMessage(hint: string, staged: string[]): string {
    const base = hint.replace(/\s+/g, " ").trim();
    const names = staged
      .map((p) => p.split("/").pop() || p)
      .slice(0, 4)
      .join(", ");
    const more = staged.length > 4 ? ` 他${staged.length - 4}件` : "";
    const filePart = names ? ` [${names}${more}]` : "";
    return (base + filePart).slice(0, 200) || "checkpoint";
  }

  /** 巨大ファイルをステージから外し、 以後も拾わないよう exclude に追記 (M3) */
  private async unstageOversized(): Promise<void> {
    for (const rel of await this.stagedFiles()) {
      try {
        const abs = path.join(this.workTree, rel);
        const st = fs.statSync(abs);
        if (st.isFile() && st.size > this.maxFileSizeBytes) {
          await this.git(["reset", "-q", "--", rel]);
          this.appendExclude(rel);
          logger.debug(`checkpoint: 巨大ファイルを除外 (${Math.round(st.size / 1048576)}MB): ${rel}`);
        }
      } catch {
        /* 削除済み等は無視 */
      }
    }
  }

  private appendExclude(rel: string): void {
    try {
      fs.appendFileSync(path.join(this.gitDir, "info", "exclude"), rel + "\n");
    } catch {
      /* skip */
    }
  }

  async list(limit = 30): Promise<CheckpointEntry[]> {
    if (!(await this.ensureInit())) return [];
    try {
      const { stdout } = await this.git(["log", `-n${Math.max(limit, 1)}`, "--pretty=format:%H%x1f%cI%x1f%s"]);
      const lines = stdout.split("\n").filter((l) => l.trim());
      return lines.map((line, i) => {
        const [hash, date, ...rest] = line.split("\x1f");
        return {
          n: i + 1,
          hash,
          shortHash: hash.slice(0, 8),
          date,
          message: rest.join("\x1f"),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * n 番目 (1=直近) のチェックポイントへ作業フォルダを「完全に」復元する (H2)。
   * 単なる checkout では対象コミット以降に追加されたファイルが残り「戻したのに壊れたまま」に
   * なるため、 追加分を削除して作業ツリーを当該コミットに一致させる。
   * HEAD は進めない (= forward 履歴を温存し、 また前に進める)。
   */
  async restore(n: number): Promise<{ ok: boolean; entry?: CheckpointEntry; error?: string }> {
    const entries = await this.list(n);
    const entry = entries.find((e) => e.n === n);
    if (!entry) return { ok: false, error: `チェックポイント #${n} が見つかりません` };
    // 自動コミットと index.lock を取り合わないよう、 復元全体をキューに載せて直列化する
    let result: { ok: boolean; entry?: CheckpointEntry; error?: string } = { ok: false, entry };
    this.queue = this.queue
      .then(async () => {
        // 1) 復元前に現状をスナップショット (戻しすぎても失わない / 追加ファイルを追跡下に置く)
        await this.doCommit(`auto: #${n} 復元前のスナップショット`);
        // 2) 対象コミット以降に「追加/コピーされた」ファイルを洗い出す。
        //    --no-renames を付けないと rename 先が R 扱いになり取りこぼす (= 余分なファイルが残る)。
        let added: string[] = [];
        try {
          const { stdout } = await this.git([
            "diff",
            "--no-renames",
            "--diff-filter=AC",
            "--name-only",
            entry.hash,
            "HEAD",
          ]);
          added = stdout
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        } catch {
          /* 履歴が浅い等は空 */
        }
        // 3) 追跡ファイルを対象コミットの内容へ復元
        await this.git(["checkout", entry.hash, "--", "."]);
        // 4) 対象時点に存在しなかったファイルを作業ツリーから除去 (= 完全一致)。 空になった親dirも掃除
        for (const rel of added) {
          try {
            const abs = path.join(this.workTree, rel);
            fs.rmSync(abs, { force: true });
            this.removeEmptyParents(path.dirname(abs));
          } catch {
            /* skip */
          }
        }
        result = { ok: true, entry };
      })
      .catch((e) => {
        result = { ok: false, entry, error: String(e) };
      });
    await this.queue;
    return result;
  }

  /** rel 削除後、 空になった親ディレクトリを work-tree 内に限り掃除する */
  private removeEmptyParents(dir: string): void {
    const root = path.resolve(this.workTree);
    let cur = path.resolve(dir);
    try {
      while (cur.startsWith(root + path.sep) && cur !== root) {
        if (fs.readdirSync(cur).length > 0) break;
        fs.rmdirSync(cur);
        cur = path.dirname(cur);
      }
    } catch {
      /* skip */
    }
  }

  /** 今セッションのチェックポイント履歴を削除 (作業フォルダのファイルは無傷) */
  clearCurrent(): boolean {
    try {
      fs.rmSync(this.gitDir, { recursive: true, force: true });
      this.initialized = false;
      return true;
    } catch {
      return false;
    }
  }

  /** 全セッションのチェックポイントを削除。 削除したセッション数を返す */
  clearAll(): number {
    let n = 0;
    try {
      if (!fs.existsSync(this.root)) return 0;
      for (const d of fs.readdirSync(this.root)) {
        const p = path.join(this.root, d);
        try {
          if (fs.statSync(p).isDirectory()) {
            fs.rmSync(p, { recursive: true, force: true });
            n++;
          }
        } catch {
          /* skip */
        }
      }
      this.initialized = false;
    } catch {
      /* ignore */
    }
    return n;
  }

  /**
   * 保持ポリシーに沿って古いセッションを掃除する (セッション開始時に呼ぶ)。
   * 現在のセッションは常に残す。 同期 fs 操作で軽量。 削除数を返す。
   */
  pruneOldSessions(): number {
    const maxSessions = this.retention?.maxSessions ?? 20;
    const maxAgeDays = this.retention?.maxAgeDays ?? 60;
    let removed = 0;
    try {
      if (!fs.existsSync(this.root)) return 0;
      const now = Date.now();
      const entries = fs
        .readdirSync(this.root)
        .map((d) => {
          const p = path.join(this.root, d);
          try {
            const st = fs.statSync(p);
            if (!st.isDirectory()) return null;
            // 「最終更新 (最後にチェックポイントした日)」 を基準にする。 開始日ではない。
            return { d, p, mtime: this.sessionLastActivityMs(p) };
          } catch {
            return null;
          }
        })
        .filter((x): x is { d: string; p: string; mtime: number } => !!x && x.d !== this.sessionId);

      const survivors: { d: string; p: string; mtime: number }[] = [];
      // 年齢ベース
      for (const e of entries) {
        if (maxAgeDays > 0 && now - e.mtime > maxAgeDays * 86_400_000) {
          try {
            fs.rmSync(e.p, { recursive: true, force: true });
            removed++;
          } catch {
            /* skip */
          }
        } else {
          survivors.push(e);
        }
      }
      // 件数ベース (新しい順に maxSessions だけ残す)
      if (maxSessions > 0 && survivors.length > maxSessions) {
        survivors.sort((a, b) => b.mtime - a.mtime);
        for (const e of survivors.slice(maxSessions)) {
          try {
            fs.rmSync(e.p, { recursive: true, force: true });
            removed++;
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* ignore */
    }
    if (removed > 0) logger.debug(`checkpoint: 古いセッションを ${removed} 件掃除`);
    return removed;
  }

  /**
   * セッションの「最終更新時刻」(最後にコミットした時刻) を返す。
   * commit のたびに reflog が追記される `logs/HEAD` の mtime が最も信頼できる。
   * 取れなければ HEAD / index / ディレクトリ自身の mtime にフォールバックし、最大値を採る。
   * ※ ディレクトリ作成日 (= セッション開始日) ではなく、最後の活動日を測るのが目的。
   */
  private sessionLastActivityMs(dir: string): number {
    // logs/HEAD は commit/ref 更新のたびに追記される → mtime = 最終コミット時刻 (最も信頼できる)
    try {
      return fs.statSync(path.join(dir, "logs", "HEAD")).mtimeMs;
    } catch {
      /* reflog 無し (コミットが無い等) → フォールバック */
    }
    let latest = 0;
    for (const c of [path.join(dir, "HEAD"), path.join(dir, "index"), dir]) {
      try {
        const m = fs.statSync(c).mtimeMs;
        if (m > latest) latest = m;
      } catch {
        /* skip */
      }
    }
    return latest;
  }

  /** n 番目と現在の作業ツリーの差分サマリ */
  async diffStat(n: number): Promise<string> {
    const entries = await this.list(n);
    const entry = entries.find((e) => e.n === n);
    if (!entry) return `チェックポイント #${n} が見つかりません`;
    try {
      const { stdout } = await this.git(["diff", "--stat", entry.hash, "--", "."]);
      return stdout.trim() || "(差分なし)";
    } catch (e) {
      return String(e);
    }
  }
}
