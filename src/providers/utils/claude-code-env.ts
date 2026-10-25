/**
 * claude コマンド (claude-cli / claude-agent-sdk の子プロセス) に渡す環境変数。
 *
 * claude コマンドにはリクエストの max_tokens を直接渡す口が無い。 出力の上限は環境変数
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS で決まるので、 ChatParams.maxTokens があればそこに載せる
 * (本体呼び出しの出力上限 O。 docs/context-reduction-redesign.md §4.2)。 無ければ process.env のまま。
 */
export function claudeCodeEnv(maxTokens: number | undefined): NodeJS.ProcessEnv {
  if (!maxTokens) return process.env;
  return { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) };
}
