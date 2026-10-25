import { describe, it, expect, vi } from "vitest";
import { getDefaultConfig } from "../../src/config/types.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import {
  addPatternRule,
  addToolToList,
  getToolList,
  removePatternRule,
  removeToolFromList,
  type ToolListKind,
} from "../../src/cli/permission-settings.js";

/**
 * /permission 画面が呼ぶ設定関数 (docs/todo-legacy-ways-cleanup.md T3)。
 * 旧サブコマンド (auto-add / rule-add 等) を削除したため、 画面からの変更はすべてここを通る。
 * 実行中の PermissionManager と config.security の両方が変わり、 保存が 1 回呼ばれることを確かめる。
 */
function makeCtx() {
  const config = getDefaultConfig();
  config.security.autoApproveTools = [];
  config.security.requireApprovalTools = [];
  config.security.discordAutoApproveTools = [];
  config.security.slackAutoApproveTools = [];
  config.security.rules = { allow: [], deny: [], ask: [] };
  const permissions = new PermissionManager(config.security);
  const save = vi.fn();
  return { config, permissions, save };
}

describe("permission-settings", () => {
  it("パターンルールの追加・削除が実行中の設定と config の両方に反映され保存される", () => {
    const ctx = makeCtx();
    addPatternRule(ctx, "allow", "bash(npm *)");
    addPatternRule(ctx, "allow", "bash(npm *)"); // 重複は増えない
    expect(ctx.permissions.getRules().allow).toEqual(["bash(npm *)"]);
    expect(ctx.config.security.rules?.allow).toEqual(["bash(npm *)"]);
    removePatternRule(ctx, "allow", "bash(npm *)");
    expect(ctx.permissions.getRules().allow).toEqual([]);
    expect(ctx.config.security.rules?.allow).toEqual([]);
    expect(ctx.save).toHaveBeenCalledTimes(3);
  });

  const keyOf: Record<ToolListKind, keyof ReturnType<typeof getDefaultConfig>["security"]> = {
    auto: "autoApproveTools",
    require: "requireApprovalTools",
    discord: "discordAutoApproveTools",
    slack: "slackAutoApproveTools",
  };

  it.each(["auto", "require", "discord", "slack"] as const)("ツール名一覧 %s の追加・削除", (kind) => {
    const ctx = makeCtx();
    addToolToList(ctx, kind, "web_fetch");
    addToolToList(ctx, kind, "web_fetch");
    expect(getToolList(ctx.permissions, kind)).toEqual(["web_fetch"]);
    expect(ctx.config.security[keyOf[kind]]).toEqual(["web_fetch"]);
    removeToolFromList(ctx, kind, "web_fetch");
    expect(getToolList(ctx.permissions, kind)).toEqual([]);
    expect(ctx.config.security[keyOf[kind]]).toEqual([]);
    expect(ctx.save).toHaveBeenCalledTimes(3);
  });

  it("Discord / Slack の一覧が未定義の config でも追加できる", () => {
    const ctx = makeCtx();
    ctx.config.security.discordAutoApproveTools = undefined;
    ctx.config.security.slackAutoApproveTools = undefined;
    addToolToList(ctx, "discord", "bash");
    addToolToList(ctx, "slack", "bash");
    expect(ctx.config.security.discordAutoApproveTools).toEqual(["bash"]);
    expect(ctx.config.security.slackAutoApproveTools).toEqual(["bash"]);
  });
});
