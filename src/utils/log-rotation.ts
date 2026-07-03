/**
 * ログ・セッションの世代管理 (docs/production-readiness.md PR-15)。
 *
 * 起動時に一度だけ呼ばれる軽量な掃除:
 * - ~/.localllm/logs/ops/*.jsonl      … 保持日数を超えたものを削除 (既定 30日)
 * - ~/.localllm/logs/sessions/*.jsonl … 同上 (LLM I/O ログはプロンプト全文を含み肥大が速い)
 * - ~/.localllm/sessions/*.json       … 新しい順に保持件数を超えたものを削除 (既定 100件)
 *
 * 方針:
 * - 削除したら件数を notices で返し、呼び出し側が1行表示する (黙って消さない)
 * - 0 指定で無制限 (checkpoints.retention と同じ流儀)
 * - 掃除の失敗は本体起動を止めない (ファイル単位で握って続行)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { LogRetentionConfig } from "../config/types.js";

const DEFAULT_LOG_MAX_AGE_DAYS = 30;
const DEFAULT_SESSION_MAX_COUNT = 100;

export interface LogRetentionResult {
  /** 削除したログファイル数 (ops + LLM I/O) */
  deletedLogs: number;
  /** 削除したセッション JSON 数 */
  deletedSessions: number;
  /** ユーザーへ表示する1行通知 (削除が無ければ空) */
  notices: string[];
}

/** dir 直下のファイルのうち、mtime が cutoff より古いものを削除して件数を返す */
function deleteOlderThan(dir: string, extension: string, cutoffMs: number): number {
  let deleted = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // ディレクトリが無い = 掃除対象なし
  }
  for (const name of names) {
    if (!name.endsWith(extension)) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch {
      // 個別ファイルの失敗 (並行削除・権限等) は無視して続行
    }
  }
  return deleted;
}

/** dir 直下のファイルを mtime 降順に並べ、keep 件を超えた分を削除して件数を返す */
function keepNewest(dir: string, extension: string, keep: number): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const files: { filePath: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(extension)) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) files.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // 読めないファイルは対象外
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let deleted = 0;
  for (const file of files.slice(keep)) {
    try {
      fs.unlinkSync(file.filePath);
      deleted++;
    } catch {
      // 続行
    }
  }
  return deleted;
}

/**
 * 世代管理を適用する。baseDir はテスト用に差し替え可能 (既定 ~/.localllm)。
 */
export function applyLogRetention(
  cfg: LogRetentionConfig | undefined,
  baseDir: string = path.join(os.homedir(), ".localllm"),
): LogRetentionResult {
  const logMaxAgeDays = cfg?.logMaxAgeDays ?? DEFAULT_LOG_MAX_AGE_DAYS;
  const sessionMaxCount = cfg?.sessionMaxCount ?? DEFAULT_SESSION_MAX_COUNT;
  const notices: string[] = [];

  let deletedLogs = 0;
  if (logMaxAgeDays > 0) {
    const cutoffMs = Date.now() - logMaxAgeDays * 24 * 60 * 60 * 1000;
    deletedLogs += deleteOlderThan(path.join(baseDir, "logs", "ops"), ".jsonl", cutoffMs);
    deletedLogs += deleteOlderThan(path.join(baseDir, "logs", "sessions"), ".jsonl", cutoffMs);
    if (deletedLogs > 0) {
      notices.push(`${logMaxAgeDays}日より古いログを ${deletedLogs} 件削除しました (logging.retention で変更可能)`);
    }
  }

  let deletedSessions = 0;
  if (sessionMaxCount > 0) {
    deletedSessions = keepNewest(path.join(baseDir, "sessions"), ".json", sessionMaxCount);
    if (deletedSessions > 0) {
      notices.push(
        `古いセッションを ${deletedSessions} 件削除しました (直近${sessionMaxCount}件を保持。logging.retention で変更可能)`,
      );
    }
  }

  return { deletedLogs, deletedSessions, notices };
}
