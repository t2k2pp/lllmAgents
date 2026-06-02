import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as logger from "../utils/logger.js";

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

export class CheckpointManager {
  private readonly gitDir: string;
  private readonly workTree: string;
  private enabled: boolean;
  private gitAvailable: boolean | null = null;
  private initialized = false;
  /** index.lock 競合を避けるための直列化キュー */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: { sessionId: string; workTree?: string; enabled?: boolean }) {
    this.gitDir = path.join(os.homedir(), ".localllm", "checkpoints", opts.sessionId);
    this.workTree = opts.workTree ?? process.cwd();
    this.enabled = opts.enabled ?? false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  /** git コマンドが使えるか (初回だけ実測してキャッシュ) */
  private async ensureGit(): Promise<boolean> {
    if (this.gitAvailable !== null) return this.gitAvailable;
    try {
      await execFileAsync("git", ["--version"]);
      this.gitAvailable = true;
    } catch {
      this.gitAvailable = false;
      logger.debug("checkpoint: git が見つからないためチェックポイントは無効");
    }
    return this.gitAvailable;
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    // --git-dir と --work-tree を明示することで「作業フォルダの外」 に履歴を持つ
    return execFileAsync(
      "git",
      [`--git-dir=${this.gitDir}`, `--work-tree=${this.workTree}`, ...args],
      { maxBuffer: 16 * 1024 * 1024 },
    );
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
      // 巨大/不要ディレクトリを除外 (作業フォルダ内 .gitignore も併せて尊重される)
      const exclude = [
        "node_modules/",
        ".git/",
        "dist/",
        "deploy/",
        ".localllm/",
        "*.log",
        ".DS_Store",
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
    this.queue = this.queue.then(() => this.doCommit(message)).catch((e) => {
      logger.debug(`checkpoint: commit 失敗 — ${String(e)}`);
    });
    await this.queue;
  }

  /** 明示コミット (known-good タグ等)。 戻り値はコミットしたか否か */
  async commit(message: string): Promise<boolean> {
    if (!(await this.ensureInit())) return false;
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

  private async doCommit(message: string): Promise<boolean> {
    if (!(await this.ensureInit())) return false;
    await this.git(["add", "-A"]);
    // ステージに差分が無ければコミットしない
    try {
      await this.git(["diff", "--cached", "--quiet"]);
      return false; // 差分なし
    } catch {
      // 差分あり → コミット
    }
    const msg = message.replace(/\s+/g, " ").slice(0, 200) || "checkpoint";
    await this.git(["commit", "-q", "-m", msg]);
    return true;
  }

  async list(limit = 30): Promise<CheckpointEntry[]> {
    if (!(await this.ensureInit())) return [];
    try {
      const { stdout } = await this.git([
        "log",
        `-n${limit}`,
        "--pretty=format:%H%x1f%cI%x1f%s",
      ]);
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

  /** n 番目 (1=直近) のチェックポイントへ作業フォルダを復元 */
  async restore(n: number): Promise<{ ok: boolean; entry?: CheckpointEntry; error?: string }> {
    const entries = await this.list(Math.max(n, 30));
    const entry = entries.find((e) => e.n === n);
    if (!entry) return { ok: false, error: `チェックポイント #${n} が見つかりません` };
    try {
      // 対象コミットの内容で作業ツリーを上書き (追跡ファイルを復元)
      await this.git(["checkout", entry.hash, "--", "."]);
      return { ok: true, entry };
    } catch (e) {
      return { ok: false, entry, error: String(e) };
    }
  }

  /** n 番目との差分サマリ */
  async diffStat(n: number): Promise<string> {
    const entries = await this.list(Math.max(n, 30));
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
