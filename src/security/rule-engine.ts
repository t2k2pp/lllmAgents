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

// Claude Code スタイルのエイリアス → 内部ツール名
const TOOL_ALIASES: Record<string, string> = {
  bash: "bash",
  read: "file_read",
  write: "file_write",
  edit: "file_edit",
  glob: "glob",
  grep: "grep",
  webfetch: "web_fetch",
  websearch: "web_search",
  agent: "sub_agent",
  // file_ 系もそのまま通す
  file_read: "file_read",
  file_write: "file_write",
  file_edit: "file_edit",
  web_fetch: "web_fetch",
  web_search: "web_search",
};

/**
 * パターン文字列をパースして { toolName, argPattern } に分解する。
 * 例: "bash(npm *)" → { toolName: "bash", argPattern: "npm *" }
 *     "file_write"  → { toolName: "file_write", argPattern: null }
 */
function parsePattern(pattern: string): { toolName: string; argPattern: string | null } {
  const parenMatch = pattern.match(/^([^(]+)\((.+)\)$/);
  if (parenMatch) {
    const rawTool = parenMatch[1].trim().toLowerCase();
    const toolName = TOOL_ALIASES[rawTool] ?? rawTool;
    return { toolName, argPattern: parenMatch[2].trim() };
  }
  const rawTool = pattern.trim().toLowerCase();
  const toolName = TOOL_ALIASES[rawTool] ?? rawTool;
  return { toolName, argPattern: null };
}

/**
 * glob スタイルのパターンを RegExp に変換する。
 * "*"  → 任意の文字列（スペース・スラッシュ含む）
 * "**" → 同上（パス区切りを意識したより明示的な指定用）
 * "?"  → 任意の1文字
 */
function globToRegex(pattern: string): RegExp {
  let result = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      // ** も * も同じ扱い（任意文字列）
      if (pattern[i + 1] === "*") {
        result += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // **/foo のスラッシュをスキップ
      } else {
        result += ".*";
        i++;
      }
    } else if (ch === "?") {
      result += ".";
      i++;
    } else {
      result += escapeRegexChar(ch);
      i++;
    }
  }
  result += "$";
  return new RegExp(result, "i"); // case-insensitive でファイルパスも対応
}

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * ツールのパラメータからパターンマッチ対象となる文字列を抽出する。
 * - bash: command
 * - file_*: file_path
 * - glob: pattern
 * - grep: path または pattern
 * - web_fetch: url
 * - web_search: query
 * - その他: JSON.stringify(params)
 */
function extractMatchTarget(toolName: string, params: Record<string, unknown>): string {
  switch (toolName) {
    case "bash":
      return String(params.command ?? "");
    case "file_read":
    case "file_write":
    case "file_edit":
      return String(params.file_path ?? params.path ?? "");
    case "glob":
      return String(params.pattern ?? params.path ?? "");
    case "grep":
      return String(params.path ?? params.pattern ?? "");
    case "web_fetch":
      return String(params.url ?? "");
    case "web_search":
      return String(params.query ?? "");
    default:
      return JSON.stringify(params);
  }
}

/**
 * argPattern とターゲット文字列がマッチするか判定する。
 * "domain:example.com" 形式の場合は URL ドメインチェック。
 */
function matchesArgPattern(argPattern: string, target: string, toolName: string): boolean {
  // domain: 形式の特殊チェック
  if (argPattern.startsWith("domain:") && toolName === "web_fetch") {
    const domain = argPattern.slice(7).toLowerCase();
    try {
      const url = new URL(target);
      return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  }
  return globToRegex(argPattern).test(target);
}

/**
 * 1つのルールパターンがこのツール呼び出しにマッチするか判定する。
 */
function matchesRule(pattern: string, toolName: string, params: Record<string, unknown>): boolean {
  const parsed = parsePattern(pattern);
  if (parsed.toolName !== toolName) return false;
  if (parsed.argPattern === null) return true; // 引数パターンなし = 全マッチ
  const target = extractMatchTarget(toolName, params);
  return matchesArgPattern(parsed.argPattern, target, toolName);
}

/**
 * ルールセットを評価し、最初にマッチした action を返す。
 * どのルールにもマッチしなければ null を返す（上位の判定に委ねる）。
 *
 * 評価順: deny > allow > ask
 */
export function evaluateRules(
  rules: SecurityRuleConfig,
  toolName: string,
  params: Record<string, unknown>,
): RuleAction | null {
  for (const pattern of rules.deny) {
    if (matchesRule(pattern, toolName, params)) return "deny";
  }
  for (const pattern of rules.allow) {
    if (matchesRule(pattern, toolName, params)) return "allow";
  }
  for (const pattern of rules.ask) {
    if (matchesRule(pattern, toolName, params)) return "ask";
  }
  return null;
}
