/**
 * コンテキスト整理の旧設定キーを 1 回だけ削除する (docs/context-reduction-redesign.md §11.1 / §11.2)。
 *
 * 整理のやり方を 1 つにしたため、 旧方式の設定キーは対応する設定が無い。 値の読み替えはせず、 消して告知する。
 * 旧キーを見るのはここだけ (実行時はどれも読まない)。 バックアップ・保存・告知の仕組みは one-time-migration.ts。
 *
 * 削除するキー (git の履歴で旧スキーマにあったものを全部):
 *   - context.reduction                     (compress / forget / hybrid。 タスク 8 で廃止)
 *   - context.forgetting.*                  (keepRecentSegments / targetMarginRatio / sufficiencyRatio / minIntervalTurns。 同上)
 *   - context.strategy.*                    (mode / minIntervalTurns。 同上)
 *   - context.compressionThreshold / context.maxHistoryMessages
 *                                           (2026-10-25 T1 で型から消したが config.json に残っていたもの。 割合の閾値と履歴の件数)
 *   - modelCapabilities.<id>.compressionThreshold / keepRecentMessages (タスク 8 で廃止)
 * context.forgetting / context.strategy は旧キーだけの入れ物なので、 中身ごと消す。
 */
import type { OneTimeMigration } from "./one-time-migration.js";

/** context 直下の旧キー。 forgetting / strategy は入れ物ごと消す */
const LEGACY_CONTEXT_KEYS = [
  "reduction",
  "forgetting",
  "strategy",
  "compressionThreshold",
  "maxHistoryMessages",
] as const;

/** modelCapabilities.<id> の旧キー */
const LEGACY_CAPABILITY_KEYS = ["compressionThreshold", "keepRecentMessages"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 旧キーを raw からその場で削除し、 削除したキーの一覧 (告知用の「a.b.c」 の形) を返す。
 * 入れ物 (forgetting / strategy) は中のキーを 1 つずつ並べる (中が空・オブジェクトでなければ入れ物の名前)。
 * 旧キーが無ければ何もせず空の配列 (2 回目以降の読み込みでは何も起きない)。
 */
export function removeLegacyContextKeys(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const removed: string[] = [];
  if (isRecord(raw.context)) {
    const ctx = raw.context;
    for (const key of LEGACY_CONTEXT_KEYS) {
      if (!(key in ctx)) continue;
      const value = ctx[key];
      const inner = isRecord(value) ? Object.keys(value) : [];
      if (inner.length > 0) for (const k of inner) removed.push(`context.${key}.${k}`);
      else removed.push(`context.${key}`);
      delete ctx[key];
    }
  }
  if (isRecord(raw.modelCapabilities)) {
    for (const [id, entry] of Object.entries(raw.modelCapabilities)) {
      if (!isRecord(entry)) continue;
      for (const key of LEGACY_CAPABILITY_KEYS) {
        if (!(key in entry)) continue;
        removed.push(`modelCapabilities.${id}.${key}`);
        delete entry[key];
      }
    }
  }
  return removed;
}

/** 削除したときに 1 回だけ出す告知 */
export function contextKeysRemovalNotice(backupPath: string, removed: readonly string[]): string {
  return (
    `コンテキスト整理の方式を 1 つにしたため、 次の設定を削除しました: ${removed.join(", ")}。` +
    ` 整理を早めたい場合は contextWindow を小さくしてください (元の設定: ${backupPath})。`
  );
}

/** loadConfig が当てる 1 回だけの削除 */
export const contextKeysRemoval: OneTimeMigration = {
  backupName: "context-keys-removal",
  saveFailureLabel: "コンテキスト整理の旧設定の削除",
  apply(raw) {
    const removed = removeLegacyContextKeys(raw);
    return removed.length > 0 ? (backupPath) => contextKeysRemovalNotice(backupPath, removed) : null;
  },
};
