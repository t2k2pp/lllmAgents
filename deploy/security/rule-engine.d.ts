/**
 * Claude Code 互換のパターンベース権限ルールエンジン
 *
 * ルール形式:
 *   "bash(npm *)"                  - bash ツール、command が "npm *" にマッチ
 *   "file_write(./src/**)"         - file_write ツール、file_path が "./src/**" にマッチ
 *   "web_fetch(domain:github.com)" - web_fetch ツール、URL が github.com ドメイン
 *   "bash"                         - bash ツール（引数問わず）
 *
 * Claude Code スタイルのエイリアスも対応:
 *   Bash / Read / Write / Edit / Glob / Grep / WebFetch / WebSearch / Agent
 */
export type RuleAction = "allow" | "deny" | "ask";
export interface SecurityRuleConfig {
    allow: string[];
    deny: string[];
    ask: string[];
}
/**
 * ルールセットを評価し、最初にマッチした action を返す。
 * どのルールにもマッチしなければ null を返す（上位の判定に委ねる）。
 *
 * 評価順: deny > allow > ask
 */
export declare function evaluateRules(rules: SecurityRuleConfig, toolName: string, params: Record<string, unknown>): RuleAction | null;
//# sourceMappingURL=rule-engine.d.ts.map