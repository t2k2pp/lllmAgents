/**
 * Claude Code 式のツール名 → このアプリの内部ツール名 の対応表 (1 か所に集約)。
 *
 * 権限ルール (security.rules の "Bash(npm *)" 等) とスキルの tools / allowed-tools
 * (Claude Code 用に書かれた SKILL.md) の両方がこの表を使う。
 * 以前は rule-engine.ts と skill-loader.ts に別々の表があり、 内容がずれていた
 * (rule-engine の Agent が実在しない sub_agent を指していた)。
 * docs/archive/todo-legacy-ways-cleanup.md T1
 *
 * キーは小文字。 照合は大文字小文字を区別しない ("Bash" も "bash" も bash)。
 */
const CLAUDE_CODE_TOOL_ALIASES: Readonly<Record<string, string>> = {
  bash: "bash",
  read: "file_read",
  write: "file_write",
  edit: "file_edit",
  glob: "glob",
  grep: "grep",
  webfetch: "web_fetch",
  websearch: "web_search",
  // Claude Code のサブエージェント起動ツール (旧名 Task、 現名 Agent)。 内部名は task
  agent: "task",
  task: "task",
};

/**
 * Claude Code 式のツール名なら内部名に変換し、 それ以外はそのまま返す。
 * 内部名 (file_read 等) を渡した場合もそのまま返る。
 */
export function resolveToolAlias(name: string): string {
  return CLAUDE_CODE_TOOL_ALIASES[name.toLowerCase()] ?? name;
}
