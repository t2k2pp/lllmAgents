/**
 * /permission 画面の設定操作 (権限ルール・ツール名一覧の追加/削除)。
 *
 * 権限の設定は /permission の対話画面 1 つに揃えた (旧サブコマンド auto-add / rule-add 等は削除。
 * docs/todo-legacy-ways-cleanup.md T3)。 画面からはここにある関数を直接呼ぶ。
 * 各関数は実行中の PermissionManager と設定 (config.security) の両方を更新し、 ctx.save() で保存する。
 */
import type { Config } from "../config/types.js";
import type { PermissionManager } from "../security/permission-manager.js";

export type RuleAction = "allow" | "deny" | "ask";
export type ToolListKind = "auto" | "require" | "discord" | "slack";

export interface PermissionSettingsContext {
  config: Config;
  permissions: PermissionManager;
  /** 設定ファイルへ保存する (通常は () => saveConfig(config)) */
  save: () => void;
}

export function addPatternRule(ctx: PermissionSettingsContext, action: RuleAction, pattern: string): void {
  ctx.permissions.addRule(action, pattern);
  ctx.config.security.rules ??= { allow: [], deny: [], ask: [] };
  if (!ctx.config.security.rules[action].includes(pattern)) ctx.config.security.rules[action].push(pattern);
  ctx.save();
}

export function removePatternRule(ctx: PermissionSettingsContext, action: RuleAction, pattern: string): void {
  ctx.permissions.removeRule(action, pattern);
  if (ctx.config.security.rules) {
    ctx.config.security.rules[action] = ctx.config.security.rules[action].filter((p) => p !== pattern);
  }
  ctx.save();
}

export function getToolList(permissions: PermissionManager, kind: ToolListKind): string[] {
  switch (kind) {
    case "auto":
      return permissions.getAutoApproveList();
    case "require":
      return permissions.getRequireApprovalList();
    case "discord":
      return permissions.getDiscordAutoApproveList();
    case "slack":
      return permissions.getSlackAutoApproveList();
  }
}

export function addToolToList(ctx: PermissionSettingsContext, kind: ToolListKind, tool: string): void {
  const sec = ctx.config.security;
  // 実行中の一覧と同じ配列を共有している場合があるため、 置き換えずにその場で追加する (以前の動作と同じ)
  const push = (list: string[]): string[] => {
    if (!list.includes(tool)) list.push(tool);
    return list;
  };
  switch (kind) {
    case "auto":
      ctx.permissions.addAutoApprove(tool);
      sec.autoApproveTools = push(sec.autoApproveTools);
      break;
    case "require":
      ctx.permissions.addRequireApproval(tool);
      sec.requireApprovalTools = push(sec.requireApprovalTools);
      break;
    case "discord":
      ctx.permissions.addDiscordAutoApprove(tool);
      sec.discordAutoApproveTools = push(sec.discordAutoApproveTools ?? []);
      break;
    case "slack":
      ctx.permissions.addSlackAutoApprove(tool);
      sec.slackAutoApproveTools = push(sec.slackAutoApproveTools ?? []);
      break;
  }
  ctx.save();
}

export function removeToolFromList(ctx: PermissionSettingsContext, kind: ToolListKind, tool: string): void {
  const sec = ctx.config.security;
  const drop = (list: string[] | undefined): string[] => (list ?? []).filter((t) => t !== tool);
  switch (kind) {
    case "auto":
      ctx.permissions.removeAutoApprove(tool);
      sec.autoApproveTools = drop(sec.autoApproveTools);
      break;
    case "require":
      ctx.permissions.removeRequireApproval(tool);
      sec.requireApprovalTools = drop(sec.requireApprovalTools);
      break;
    case "discord":
      ctx.permissions.removeDiscordAutoApprove(tool);
      sec.discordAutoApproveTools = drop(sec.discordAutoApproveTools);
      break;
    case "slack":
      ctx.permissions.removeSlackAutoApprove(tool);
      sec.slackAutoApproveTools = drop(sec.slackAutoApproveTools);
      break;
  }
  ctx.save();
}
