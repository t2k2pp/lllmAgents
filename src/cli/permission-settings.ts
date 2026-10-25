/**
 * /permission 画面の設定操作 (権限ルールの追加/削除・面ごとの一覧)。
 *
 * 権限の設定は /permission の対話画面 1 つに揃えた (旧サブコマンド auto-add / rule-add 等は T3 で削除)。
 * 権限の表し方は security.rules のルールだけ (旧ツール名一覧 autoApproveTools 等は T4 で廃止。
 * docs/todo-legacy-ways-cleanup.md)。 画面からはここにある関数を直接呼ぶ。
 * 各関数は実行中の PermissionManager と設定 (config.security.rules) の両方を更新し、 ctx.save() で保存する。
 */
import type { Config } from "../config/types.js";
import type { PermissionManager } from "../security/permission-manager.js";
import { formatRule, parseRule, type RuleSurface } from "../security/rule-engine.js";

export type RuleAction = "allow" | "deny" | "ask";
/** 画面で扱うルールの効く範囲。 "all" = 面の指定なし (すべての面) */
export type RuleScope = RuleSurface | "all";
export const RULE_SCOPES: readonly RuleScope[] = ["all", "cli", "discord", "slack"];
export const RULE_ACTIONS: readonly RuleAction[] = ["deny", "allow", "ask"];
export const RULE_SCOPE_LABELS: Record<RuleScope, string> = {
  all: "すべての面に効くルール",
  cli: "CLI だけのルール",
  discord: "Discord だけのルール",
  slack: "Slack だけのルール",
};

export interface PermissionSettingsContext {
  config: Config;
  permissions: PermissionManager;
  /** 設定ファイルへ保存する (通常は () => saveConfig(config)) */
  save: () => void;
}

export interface ScopedRule {
  action: RuleAction;
  /** 設定に書かれているルール文字列そのもの (例: "discord:web_fetch") */
  rule: string;
  /** 面の指定を除いた本体 (例: "web_fetch") */
  body: string;
}

/** 範囲とルール本体から、 設定に書くルール文字列を作る */
export function scopedRule(scope: RuleScope, body: string): string {
  return formatRule(scope === "all" ? null : scope, body);
}

/** ルール文字列の効く範囲 */
export function ruleScope(rule: string): RuleScope {
  return parseRule(rule).surface ?? "all";
}

/** その範囲に書かれたルール (面の指定がちょうどその範囲のもの) を deny / allow / ask の順に返す */
export function rulesForScope(permissions: PermissionManager, scope: RuleScope): ScopedRule[] {
  const rules = permissions.getRules();
  const out: ScopedRule[] = [];
  for (const action of RULE_ACTIONS) {
    for (const rule of rules[action]) {
      if (ruleScope(rule) !== scope) continue;
      const m = rule.match(/^\s*(?:cli|discord|slack)\s*:\s*(.+)$/i);
      out.push({ action, rule, body: m ? m[1] : rule });
    }
  }
  return out;
}

/** ルールを 1 つ追加する (rule は面の指定込みの文字列) */
export function addPatternRule(ctx: PermissionSettingsContext, action: RuleAction, rule: string): void {
  const trimmed = rule.trim();
  ctx.permissions.addRule(action, trimmed);
  ctx.config.security.rules ??= { allow: [], deny: [], ask: [] };
  if (!ctx.config.security.rules[action].includes(trimmed)) ctx.config.security.rules[action].push(trimmed);
  ctx.save();
}

export function removePatternRule(ctx: PermissionSettingsContext, action: RuleAction, rule: string): void {
  ctx.permissions.removeRule(action, rule);
  if (ctx.config.security.rules) {
    ctx.config.security.rules[action] = ctx.config.security.rules[action].filter((p) => p !== rule);
  }
  ctx.save();
}
