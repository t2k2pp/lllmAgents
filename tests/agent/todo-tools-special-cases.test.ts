import { describe, it, expect } from "vitest";
import { PlanManager } from "../../src/agent/plan-mode.js";
import { getDefaultConfig } from "../../src/config/types.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import * as todoModule from "../../src/tools/definitions/todo-write.js";

/**
 * 旧 todo_write ツールを削除した後も、 ToDo ツール (todo_append / todo_mark / todo_delete) が
 * 旧ツールと同じ扱い (plan mode で使える・既定で自動許可) を受けていることの検査
 * (docs/todo-legacy-ways-cleanup.md T1)。
 */
const TODO_TOOLS = ["todo_append", "todo_mark", "todo_delete"];

describe("ToDo ツールの特別扱い", () => {
  it("todo_write ツールは存在しない", () => {
    expect(Object.keys(todoModule)).not.toContain("todoWriteTool");
  });

  it("plan mode 中も ToDo ツールを使える", () => {
    const allowed = PlanManager.getPlanModeAllowedTools();
    for (const t of TODO_TOOLS) expect(allowed.has(t), t).toBe(true);
    expect(allowed.has("todo_write")).toBe(false);
  });

  it("既定設定で ToDo ツールは確認なし (本質的に安全なツール)、 todo_write は既定ルールに入らない", () => {
    const config = getDefaultConfig();
    const pm = new PermissionManager(config.security);
    for (const t of TODO_TOOLS) expect(pm.getPermissionLevel(t), t).toBe("auto");
    expect(config.security.rules?.allow).not.toContain("todo_write");
    expect(pm.getPermissionLevel("todo_write")).toBe("ask");
  });
});
