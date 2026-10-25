/**
 * config.json の 1 回だけの書き換え (旧キーの移行・削除) に共通の仕組み。
 *
 * 使っているもの:
 *   - 権限ルールへの移行 (permission-migration.ts。 docs/todo-legacy-ways-cleanup.md T4)
 *   - コンテキスト整理の旧キーの削除 (context-keys-removal.ts。 docs/context-reduction-redesign.md §11)
 *
 * 流れ (loadConfig から呼ぶ):
 *   1. applyOneTimeMigrations: 読み込んだ内容をその場で書き換える。 書き換えたものごとに、 書き換え前の
 *      config.json をバックアップする (config.json.before-<名前>.bak)。 スキーマ検証より前に呼ぶ
 *   2. finishOneTimeMigrations: 全部のバックアップが書けたときだけ保存し、 告知を 1 回ずつ出す。
 *      バックアップできなかったときは元の config.json を上書きしない (今回の起動だけ書き換え後の内容で動き、 次回また試みる)
 * 2 回目以降は旧キーが無いので何も起きない。
 */
import * as fs from "node:fs";
import { hardenFilePermissions } from "../utils/atomic-file.js";

export interface OneTimeMigration {
  /** バックアップのファイル名に入れる名前 (config.json.before-<backupName>.bak) */
  backupName: string;
  /** 保存に失敗したときの表示 (「<saveFailureLabel>を保存できませんでした: …」) */
  saveFailureLabel: string;
  /**
   * raw をその場で書き換える。 書き換えたときは告知文を作る関数 (引数はバックアップの場所) を返す。
   * 書き換えることが無ければ null (何もしない)。
   */
  apply(raw: unknown): ((backupPath: string) => string) | null;
}

export interface AppliedMigration {
  migration: OneTimeMigration;
  notice: (backupPath: string) => string;
  /** バックアップの場所。 書けなかったときは null */
  backupPath: string | null;
}

/** 移行前の config.json を残す先 (既にあれば上書きせず時刻付きの別名にする) */
export function migrationBackupPath(configPath: string, backupName: string): string {
  const base = `${configPath}.before-${backupName}.bak`;
  if (!fs.existsSync(base)) return base;
  return `${configPath}.before-${backupName}-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
}

/**
 * 移行前の内容をバックアップする。 元ファイルがあればそのままコピー、 無ければ (破損から .bak で復元した場合など)
 * 読み込んだ内容を書く。 旧形式ではシークレットを含みうるため権限を自ユーザーのみに絞る。 書いたパスを返す。
 */
export function writeMigrationBackup(configPath: string, originalParsed: unknown, backupName: string): string {
  const backupPath = migrationBackupPath(configPath, backupName);
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
  else fs.writeFileSync(backupPath, JSON.stringify(originalParsed, null, 2), "utf-8");
  hardenFilePermissions(backupPath);
  return backupPath;
}

/**
 * 移行を順に当てる (parsed をその場で書き換える)。 書き換えた移行ごとに、 書き換え前の内容をバックアップする。
 * バックアップは他の保存 (シークレットの分離など) より先に書くこと。
 */
export function applyOneTimeMigrations(
  parsed: unknown,
  configPath: string,
  migrations: readonly OneTimeMigration[],
): AppliedMigration[] {
  const originalParsed = structuredClone(parsed);
  const applied: AppliedMigration[] = [];
  for (const migration of migrations) {
    const notice = migration.apply(parsed);
    if (!notice) continue;
    let backupPath: string | null = null;
    try {
      backupPath = writeMigrationBackup(configPath, originalParsed, migration.backupName);
    } catch (e) {
      console.error(`移行前の設定のバックアップに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    applied.push({ migration, notice, backupPath });
  }
  return applied;
}

/**
 * 書き換えた内容を保存し、 告知を出す。 バックアップできなかった移行が 1 つでもあれば保存しない
 * (元の config.json を残し、 次回の起動でまた試みる)。
 */
export function finishOneTimeMigrations(applied: readonly AppliedMigration[], save: () => void): void {
  if (applied.length === 0 || applied.some((a) => a.backupPath === null)) return;
  try {
    save();
    for (const a of applied) console.log(a.notice(a.backupPath as string));
  } catch (e) {
    // 保存できなくても今回の起動は書き換え後の内容で動く (旧キーは読まない)。 次回起動で再び試みる
    const message = e instanceof Error ? e.message : String(e);
    for (const a of applied) console.error(`${a.migration.saveFailureLabel}を保存できませんでした: ${message}`);
  }
}
