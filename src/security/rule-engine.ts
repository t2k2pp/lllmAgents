/**
 * Claude Code 互換のパターンベース権限ルールエンジン。 権限の設定はこのルール (config の security.rules) だけで表す
 * (旧ツール名一覧 autoApproveTools 等は廃止。 docs/archive/todo-legacy-ways-cleanup.md T4)。
 *
 * ルール形式:
 *   "bash(npm *)"                  - bash ツール、command が "npm *" にマッチ
 *   "file_write(./src/**)"         - file_write ツール、file_path が "./src/**" にマッチ
 *   "web_fetch(domain:github.com)" - web_fetch ツール、URL が github.com ドメイン
 *   "bash"                         - bash ツール（引数問わず = ツール全体）
 *
 * 面 (surface) の指定: 先頭に "cli:" / "discord:" / "slack:" を付けるとその面だけに効く。
 *   "discord:file_read"  - Discord 経由のときだけ
 *   "cli:bash(npm *)"    - ローカルの CLI のときだけ
 *   付けなければすべての面に効く。
 *
 * allow は書き方で 2 種類に分かれる:
 *   - 引数パターン付き ("bash(npm test)") : その形に限った明示許可。 確認なしでそのまま通す (ask より強い)
 *   - ツール名だけ   ("bash")            : ツール全体の許可。 ask ルールより弱く、 安全確認は残る
 *     (サンドボックス外のパス、 bash の CWD 外参照・広域スキャン、 autorun の判定が先)。 isToolAllowedByRule で見る
 *
 * Claude Code スタイルのツール名 (Bash / Read / Write / Edit / Glob / Grep / WebFetch / WebSearch / Agent) も
 * 使える。 対応表は src/tools/tool-name-aliases.ts。
 */

import { resolveToolAlias } from "../tools/tool-name-aliases.js";

export type RuleAction = "allow" | "deny" | "ask";

/** ルールを効かせる面。 RequestSource (permission-manager.ts) と同じ */
export type RuleSurface = "cli" | "discord" | "slack";
export const RULE_SURFACES: readonly RuleSurface[] = ["cli", "discord", "slack"];

export interface SecurityRuleConfig {
  allow: string[];
  deny: string[];
  ask: string[];
}

export interface ParsedRule {
  /** null = すべての面 */
  surface: RuleSurface | null;
  toolName: string;
  /** null = 引数パターンなし (ツール全体) */
  argPattern: string | null;
}

const SURFACE_PREFIX_RE = /^\s*(cli|discord|slack)\s*:\s*(.+)$/i;

/** ルール文字列を { 面, ツール名, 引数パターン } に分解する */
export function parseRule(rule: string): ParsedRule {
  const m = rule.match(SURFACE_PREFIX_RE);
  const surface = m ? (m[1].toLowerCase() as RuleSurface) : null;
  const body = m ? m[2] : rule;
  return { surface, ...parsePattern(body) };
}

/** 面の指定とルール本体からルール文字列を作る (surface null = 指定なし = すべての面) */
export function formatRule(surface: RuleSurface | null, body: string): string {
  const trimmed = body.trim();
  return surface ? `${surface}:${trimmed}` : trimmed;
}

/** ルールがこの面に効くか */
function appliesTo(parsed: ParsedRule, surface: RuleSurface): boolean {
  return parsed.surface === null || parsed.surface === surface;
}

/**
 * パターン文字列をパースして { toolName, argPattern } に分解する。
 * 例: "bash(npm *)" → { toolName: "bash", argPattern: "npm *" }
 *     "file_write"  → { toolName: "file_write", argPattern: null }
 */
function parsePattern(pattern: string): { toolName: string; argPattern: string | null } {
  const parenMatch = pattern.match(/^([^(]+)\((.+)\)$/);
  if (parenMatch) {
    const rawTool = parenMatch[1].trim().toLowerCase();
    const toolName = resolveToolAlias(rawTool);
    return { toolName, argPattern: parenMatch[2].trim() };
  }
  const rawTool = pattern.trim().toLowerCase();
  const toolName = resolveToolAlias(rawTool);
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
function matchesRule(
  parsed: ParsedRule,
  toolName: string,
  params: Record<string, unknown>,
  surface: RuleSurface,
): boolean {
  if (!appliesTo(parsed, surface)) return false;
  if (parsed.toolName !== toolName) return false;
  if (parsed.argPattern === null) return true; // 引数パターンなし = 全マッチ
  const target = extractMatchTarget(toolName, params);
  return matchesArgPattern(parsed.argPattern, target, toolName);
}

/**
 * ルールセットを評価し、最初にマッチした action を返す。
 * どのルールにもマッチしなければ null を返す（上位の判定に委ねる）。
 *
 * 評価順: deny > 引数パターン付き allow > ask。
 * ツール名だけの allow はここでは見ない (ask より弱く、 安全確認の後に効く。 isToolAllowedByRule)。
 */
export function evaluateRules(
  rules: SecurityRuleConfig,
  toolName: string,
  params: Record<string, unknown>,
  surface: RuleSurface = "cli",
): RuleAction | null {
  if (isDeniedByRule(rules, toolName, params, surface)) return "deny";
  for (const rule of rules.allow) {
    const parsed = parseRule(rule);
    if (parsed.argPattern === null) continue;
    if (matchesRule(parsed, toolName, params, surface)) return "allow";
  }
  for (const rule of rules.ask) {
    if (matchesRule(parseRule(rule), toolName, params, surface)) return "ask";
  }
  return null;
}

/** deny ルールだけを評価する (どの経路でも最優先で強制する) */
export function isDeniedByRule(
  rules: SecurityRuleConfig,
  toolName: string,
  params: Record<string, unknown>,
  surface: RuleSurface,
): boolean {
  return rules.deny.some((rule) => matchesRule(parseRule(rule), toolName, params, surface));
}

/** この面でツール全体を許可する allow ルール (ツール名だけのもの) があるか */
export function isToolAllowedByRule(rules: SecurityRuleConfig, toolName: string, surface: RuleSurface): boolean {
  return rules.allow.some((rule) => {
    const parsed = parseRule(rule);
    return parsed.argPattern === null && appliesTo(parsed, surface) && parsed.toolName === toolName;
  });
}

/**
 * この面の allow ルールに出てくるツール名 (引数パターン付きも含む)。
 * Discord/Slack で確認手段が無いときに、 モデルへ見せるツールを絞り込むのに使う。
 */
export function allowRuleToolNames(rules: SecurityRuleConfig, surface: RuleSurface): Set<string> {
  const names = new Set<string>();
  for (const rule of rules.allow) {
    const parsed = parseRule(rule);
    if (appliesTo(parsed, surface)) names.add(parsed.toolName);
  }
  return names;
}
