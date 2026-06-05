/**
 * 破壊的 bash コマンドの正典パターン（単一ソース）。
 *
 * これまで permission-manager の AUTORUN_DESTRUCTIVE_PATTERNS と bash.ts の
 * DESTRUCTIVE_PATTERNS に分裂し、 後者にしか無い git checkout/clean 等が
 * 自動許可ゲートで漏れていた（Phase 3 レビュー C-1/H-1）。ここに集約して乖離を防ぐ。
 *
 * 用途:
 * - permission-manager: 封じ込め時/autorun の bash 自動許可から除外（→通常確認へフォールバック）
 * - bash.ts: P3-B の git status プリフライト・スナップショット対象判定
 *
 * 方針: 取りこぼしより誤検知（＝余分な確認）を許容する。封じ込めは FS 破壊を writeDir 内に
 * 閉じ込めるが、 git 履歴/作業ツリー破棄・remote への force push・低レベルデバイス書込は
 * 封じ込めで守れない不可逆操作なので必ず確認へ落とす。
 */
export const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  // 削除系
  /\brm\s/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\bshred\b/,
  /\bdel\b/i,
  /\brd\s+\/s/i,
  /\bfind\b[^|;&]*-delete\b/,
  // 上書き・切り詰め・低レベル書込
  /\btruncate\b/,
  /\bdd\s/,
  /\bmkfs\b/,
  /\bformat\s+[a-z]:/i,
  />\s*\/dev\//,
  // 再帰パーミッション/所有者変更
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
  // git 破壊（作業ツリー破棄・履歴改変・force push。 force push は任意ターゲットで確認へ）
  /\bgit\s+checkout\s+(--\s|\.\s|\.$|--$)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*[df][a-z]*\b/,
  /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/,
];

/** コマンド文字列が破壊的パターンに該当するか。 */
export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_COMMAND_PATTERNS.some((re) => re.test(command));
}
