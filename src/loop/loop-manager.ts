/**
 * LoopManager - 定期実行ループの管理
 *
 * /loop コマンドで登録されたプロンプトを一定間隔で繰り返し実行する。
 */

export interface LoopEntry {
  id: string;
  prompt: string;
  intervalMs: number;
  /** 表示用の間隔文字列 (例: "5m") */
  intervalStr: string;
  timerId: ReturnType<typeof setInterval>;
  createdAt: Date;
  lastRunAt?: Date;
  runCount: number;
}

/** ループ実行時に呼び出されるコールバック */
export type LoopRunner = (prompt: string) => Promise<void>;

/**
 * アクティブなループを管理するクラス。
 * REPL インスタンスに 1 つ保持される。
 */
export class LoopManager {
  private loops = new Map<string, LoopEntry>();
  private nextId = 1;

  /**
   * 新しいループを開始する。
   * @returns 割り当てたループ ID
   */
  start(prompt: string, intervalMs: number, intervalStr: string, runner: LoopRunner): string {
    const id = String(this.nextId++);

    const timerId = setInterval(async () => {
      const entry = this.loops.get(id);
      if (!entry) return;
      entry.lastRunAt = new Date();
      entry.runCount++;
      await runner(prompt);
    }, intervalMs);

    this.loops.set(id, {
      id,
      prompt,
      intervalMs,
      intervalStr,
      timerId,
      createdAt: new Date(),
      runCount: 0,
    });

    return id;
  }

  /**
   * 指定 ID のループを停止する。
   * @returns 停止できた場合 true、ID が存在しない場合 false
   */
  stop(id: string): boolean {
    const entry = this.loops.get(id);
    if (!entry) return false;
    clearInterval(entry.timerId);
    this.loops.delete(id);
    return true;
  }

  /**
   * 全ループを停止する。
   * @returns 停止したループ数
   */
  stopAll(): number {
    const count = this.loops.size;
    for (const entry of this.loops.values()) {
      clearInterval(entry.timerId);
    }
    this.loops.clear();
    return count;
  }

  /** アクティブなループの一覧を返す */
  list(): LoopEntry[] {
    return Array.from(this.loops.values());
  }

  /** アクティブなループ数 */
  get count(): number {
    return this.loops.size;
  }
}

/**
 * "5m", "2h", "1d", "30s" などの間隔文字列をミリ秒に変換する。
 * @returns パース成功時は { ms, label }、失敗時は null
 */
export function parseInterval(str: string): { ms: number; label: string } | null {
  const match = str.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60 * 1_000,
    h: 60 * 60 * 1_000,
    d: 24 * 60 * 60 * 1_000,
  };

  const ms = Math.round(value * multipliers[unit]);
  if (ms <= 0) return null;

  return { ms, label: str.toLowerCase() };
}

/**
 * 入力文字列から間隔とプロンプトを抽出する。
 *
 * 対応フォーマット:
 *   /loop 5m <prompt>
 *   /loop <prompt> every 20m
 *   /loop <prompt>             (デフォルト 10m)
 *
 * @param argsStr - "/loop" 以降の文字列
 */
export function parseLoopArgs(argsStr: string): {
  intervalMs: number;
  intervalStr: string;
  prompt: string;
} {
  const DEFAULT_INTERVAL_MS = 10 * 60 * 1_000; // 10分
  const DEFAULT_INTERVAL_STR = "10m";

  const trimmed = argsStr.trim();

  // "every 20m" パターン (末尾)
  const everyMatch = trimmed.match(/^([\s\S]+?)\s+every\s+(\S+)$/i);
  if (everyMatch) {
    const parsed = parseInterval(everyMatch[2]);
    if (parsed) {
      return {
        intervalMs: parsed.ms,
        intervalStr: parsed.label,
        prompt: everyMatch[1].trim(),
      };
    }
  }

  // 先頭が間隔指定の場合: "5m <prompt>"
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const parsed = parseInterval(parts[0]);
    if (parsed) {
      return {
        intervalMs: parsed.ms,
        intervalStr: parsed.label,
        prompt: parts.slice(1).join(" "),
      };
    }
  }

  // 間隔指定なし → デフォルト
  return {
    intervalMs: DEFAULT_INTERVAL_MS,
    intervalStr: DEFAULT_INTERVAL_STR,
    prompt: trimmed,
  };
}
