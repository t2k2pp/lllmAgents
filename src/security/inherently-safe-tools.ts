/**
 * ユーザーに質問する・タスク管理するなど本質的に安全なツール。
 * 権限ルール (security.rules) に関わらず常に自動許可する (ask / deny ルールに一致した場合を除く。 CLI)。
 *
 * permission-manager.ts (判定) と config/permission-migration.ts (旧一覧の移行で重複を省く) の両方が使うため、
 * 依存の少ない独立モジュールに置く。
 */
export const INHERENTLY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "ask_user",
  // ToDo 操作系 (戦略 ToDo Phase 1 — docs/strategic-todo-design.md §3.2):
  // タスク管理は本質的に副作用なし (in-memory state 操作のみ) なので Claude Code の
  // TaskCreate/TaskUpdate と同じく確認不要。
  "todo_append",
  "todo_mark",
  "todo_delete",
  "enter_plan_mode",
  "exit_plan_mode",
  "task_output",
  "task_list",
  "task_send",
  "task_cancel",
  "task_diff",
  "schedule_create",
  "schedule_list",
  "schedule_delete",
  "current_datetime",
  "sandbox_info",
  "response_complete",
]);
