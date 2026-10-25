import { describe, it, expect, vi } from "vitest";
import { getDefaultConfig } from "../../src/config/types.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import {
  addPatternRule,
  removePatternRule,
  ruleScope,
  rulesForScope,
  scopedRule,
} from "../../src/cli/permission-settings.js";

/**
 * /permission 画面が呼ぶ設定関数 (docs/archive/todo-legacy-ways-cleanup.md T3 / T4)。
 * 権限は security.rules のルールだけで表す。 画面からの変更はすべてここを通り、
 * 実行中の PermissionManager と config.security.rules の両方が変わり、 保存が呼ばれることを確かめる。
 */
function makeCtx() {
  const config = getDefaultConfig();
  config.security.rules = { allow: [], deny: [], ask: [] };
  const permissions = new PermissionManager(config.security);
  const save = vi.fn();
  return { config, permissions, save };
}

describe("permission-settings", () => {
  it("ルールの追加・削除が実行中の設定と config の両方に反映され保存される", () => {
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

  it("範囲 (すべての面 / CLI / Discord / Slack) とルール文字列の対応", () => {
    expect(scopedRule("all", "web_fetch")).toBe("web_fetch");
    expect(scopedRule("cli", " bash(npm *) ")).toBe("cli:bash(npm *)");
    expect(scopedRule("discord", "bash")).toBe("discord:bash");
    expect(ruleScope("web_fetch")).toBe("all");
    expect(ruleScope("slack:web_fetch")).toBe("slack");
    expect(ruleScope("Bash(npm *)")).toBe("all");
  });

  it("範囲ごとの一覧は面の指定がちょうどその範囲のルールだけを deny/allow/ask の順で返す", () => {
    const ctx = makeCtx();
    addPatternRule(ctx, "allow", scopedRule("all", "file_read"));
    addPatternRule(ctx, "allow", scopedRule("discord", "bash"));
    addPatternRule(ctx, "deny", scopedRule("discord", "bash(rm *)"));
    addPatternRule(ctx, "ask", scopedRule("cli", "bash(git push *)"));
    expect(rulesForScope(ctx.permissions, "discord")).toEqual([
      { action: "deny", rule: "discord:bash(rm *)", body: "bash(rm *)" },
      { action: "allow", rule: "discord:bash", body: "bash" },
    ]);
    expect(rulesForScope(ctx.permissions, "all")).toEqual([{ action: "allow", rule: "file_read", body: "file_read" }]);
    expect(rulesForScope(ctx.permissions, "cli")).toEqual([
      { action: "ask", rule: "cli:bash(git push *)", body: "bash(git push *)" },
    ]);
    expect(rulesForScope(ctx.permissions, "slack")).toEqual([]);
  });

  it("画面で追加したツール全体の allow は、 その面の判定とモデルへ見せるツールに効く", async () => {
    const ctx = makeCtx();
    addPatternRule(ctx, "allow", scopedRule("slack", "image_generate"));
    expect(ctx.permissions.getAllowedToolNames("slack").has("image_generate")).toBe(true);
    expect(ctx.permissions.getAllowedToolNames("discord").has("image_generate")).toBe(false);
    expect(ctx.permissions.getPermissionLevel("image_generate")).toBe("ask"); // CLI には効かない
    const r = await ctx.permissions.checkToolPermission("image_generate", { prompt: "x" }, "slack");
    expect(r.allowed).toBe(true);
  });
});
