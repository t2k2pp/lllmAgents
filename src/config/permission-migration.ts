/**
 * 旧ツール名一覧 → 権限ルール (security.rules) への 1 回だけの移行 (docs/todo-legacy-ways-cleanup.md T4 / 決定 C1)。
 *
 * 旧キー: security.autoApproveTools / requireApprovalTools / discordAutoApproveTools / slackAutoApproveTools。
 * config.json にどれかが残っていたら、 旧コードが下していた判定をそのまま保つルールに書き換え、 旧キーは消す。
 * 旧キーを読むのはここだけ (実行時の判定は rules しか見ない)。
 *
 * 旧コードの判定 (2026-10-25 時点) と移行の対応:
 *   - 各一覧は「既定値 ∪ 保存値」 で判定されていた (config-manager の mergeToolList)。 移行でも和集合を取る
 *   - autoApproveTools (CLI)        → ツール名だけの allow ルール。 CLI だけなら "cli:<tool>"
 *   - discordAutoApproveTools       → 同上 "discord:<tool>"
 *   - slackAutoApproveTools         → 同上 "slack:<tool>"
 *     3 つの一覧すべてにあるツールは面の指定なし "<tool>" 1 本にまとめる
 *   - requireApprovalTools          → ルール無し。 判定に使われていなかった (autoApproveTools が先に勝ち、
 *     どちらにも無いツールは元々確認。 autorun や封じ込め下の bash 自動許可も無視していた)。 ask ルールにすると
 *     autorun を止めてしまい判定が変わるため移さない
 *   - 本質的に安全なツール (INHERENTLY_SAFE_TOOLS) は一覧に関係なく常に許可されるため書かない
 *   - 既存 rules.allow / rules.ask の面の指定なしルール → "cli:" を付ける (旧コードは CLI でしか評価していなかった)
 *   - 既存 rules.deny → そのまま (旧コードもすべての面で強制していた)
 */
import { INHERENTLY_SAFE_TOOLS } from "../security/inherently-safe-tools.js";
import { parseRule, formatRule, type RuleSurface } from "../security/rule-engine.js";
import type { OneTimeMigration } from "./one-time-migration.js";

export const LEGACY_PERMISSION_KEYS = [
  "autoApproveTools",
  "requireApprovalTools",
  "discordAutoApproveTools",
  "slackAutoApproveTools",
] as const;

/** 旧 getDefaultConfig() の一覧 (移行時の和集合に使う。 2026-10-25 時点の値で固定) */
const LEGACY_DEFAULTS = {
  autoApproveTools: [
    "file_read",
    "glob",
    "grep",
    "browser_snapshot",
    "vision_analyze",
    "ask_user",
    "todo_append",
    "todo_mark",
    "todo_delete",
    "enter_plan_mode",
    "exit_plan_mode",
    "task_output",
    "task_list",
    "task_send",
    "task_cancel",
    "web_search",
    "web_fetch",
  ],
  discordAutoApproveTools: [
    "file_read",
    "glob",
    "grep",
    "web_search",
    "web_fetch",
    "browser_snapshot",
    "vision_analyze",
    "current_datetime",
    "sandbox_info",
  ],
  slackAutoApproveTools: [
    "file_read",
    "glob",
    "grep",
    "web_search",
    "web_fetch",
    "browser_snapshot",
    "vision_analyze",
    "current_datetime",
    "sandbox_info",
  ],
} as const;

export interface PermissionMigrationResult {
  migrated: boolean;
  /** requireApprovalTools に入っていたツール (判定に影響しないため移していない。 告知用) */
  droppedRequireApproval: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 文字列配列として読めれば文字列だけを返す。 配列でなければ undefined (旧コードのスキーマ検証で捨てられていた) */
function readStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/** 旧コードと同じく「既定 ∪ 保存値」 (保存値が無ければ既定) */
function effectiveList(defaults: readonly string[], saved: unknown): string[] {
  const list = readStringList(saved);
  return list ? [...new Set([...defaults, ...list])] : [...defaults];
}

export function hasLegacyPermissionKeys(raw: unknown): boolean {
  if (!isRecord(raw) || !isRecord(raw.security)) return false;
  const sec = raw.security;
  return LEGACY_PERMISSION_KEYS.some((k) => k in sec);
}

/**
 * 旧キーが残っていれば raw.security をその場で書き換える (rules を作り、 旧キーを消す)。
 * 旧キーが無ければ何もしない (2 回目以降の読み込みでは何も起きない)。
 */
export function migrateLegacyPermissionLists(raw: unknown): PermissionMigrationResult {
  if (!hasLegacyPermissionKeys(raw)) return { migrated: false, droppedRequireApproval: [] };
  const sec = (raw as { security: Record<string, unknown> }).security;

  const perSurface: Record<RuleSurface, Set<string>> = {
    cli: new Set(effectiveList(LEGACY_DEFAULTS.autoApproveTools, sec.autoApproveTools)),
    discord: new Set(effectiveList(LEGACY_DEFAULTS.discordAutoApproveTools, sec.discordAutoApproveTools)),
    slack: new Set(effectiveList(LEGACY_DEFAULTS.slackAutoApproveTools, sec.slackAutoApproveTools)),
  };
  const droppedRequireApproval = readStringList(sec.requireApprovalTools) ?? [];

  // 一覧の順序を保ちつつ、 ツールごとに許可されていた面を集める
  const toolOrder: string[] = [];
  for (const surface of ["cli", "discord", "slack"] as const) {
    for (const tool of perSurface[surface]) {
      if (!INHERENTLY_SAFE_TOOLS.has(tool) && !toolOrder.includes(tool)) toolOrder.push(tool);
    }
  }
  const listRules: string[] = [];
  for (const tool of toolOrder) {
    const surfaces = (["cli", "discord", "slack"] as const).filter((s) => perSurface[s].has(tool));
    if (surfaces.length === 3) listRules.push(formatRule(null, tool));
    else for (const s of surfaces) listRules.push(formatRule(s, tool));
  }

  const oldRules = isRecord(sec.rules) ? sec.rules : {};
  const toCli = (rule: string): string => (parseRule(rule).surface === null ? formatRule("cli", rule) : rule);
  const allow = [...listRules, ...(readStringList(oldRules.allow) ?? []).map(toCli)];
  const ask = (readStringList(oldRules.ask) ?? []).map(toCli);
  const deny = readStringList(oldRules.deny) ?? [];

  sec.rules = { allow: [...new Set(allow)], deny: [...new Set(deny)], ask: [...new Set(ask)] };
  for (const k of LEGACY_PERMISSION_KEYS) delete sec[k];
  return { migrated: true, droppedRequireApproval };
}

/** 移行時に 1 回だけ出す告知 */
export function migrationNotice(backupPath: string, result: PermissionMigrationResult): string {
  const dropped =
    result.droppedRequireApproval.length > 0
      ? " requireApprovalTools は判定に使われていなかったため移していません。"
      : "";
  return `権限の設定 (autoApproveTools 等) を security.rules のルールに移行しました (元の設定: ${backupPath})。${dropped}`;
}

/** loadConfig が当てる 1 回だけの移行 (バックアップ・保存・告知の仕組みは one-time-migration.ts) */
export const permissionRulesMigration: OneTimeMigration = {
  backupName: "rules-migration",
  saveFailureLabel: "権限設定のルールへの移行",
  apply(raw) {
    const result = migrateLegacyPermissionLists(raw);
    return result.migrated ? (backupPath) => migrationNotice(backupPath, result) : null;
  },
};
