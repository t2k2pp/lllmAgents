import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SecurityConfig } from "../../src/config/types.js";
import { PermissionManager } from "../../src/security/permission-manager.js";

// autorun 中の game_smoke は読み取り系として自動許可する (2026-10-14 実アプリ動作確認で発覚:
// browser_* は自動許可なのに game_smoke だけ検証のたびに確認が出ていた)。
// docs/todo-request-elaboration.md 第 5 段

function mkConfig(): SecurityConfig {
  return {
    allowedDirectories: [process.cwd()],
    autoApproveTools: [], // game_smoke は自動承認リストに入れない (= autorun が無ければ確認が要る)
    requireApprovalTools: [],
    rules: { allow: [], deny: [], ask: [] },
  } as unknown as SecurityConfig;
}

describe("autorun: game_smoke", () => {
  it("サンドボックス内のページなら確認なしで許可される", async () => {
    const pm = new PermissionManager(mkConfig());
    pm.setAutorunMode(true);
    const page = path.join(process.cwd(), "sandbox", "output", "game", "index.html");
    const r = await pm.checkToolPermission("game_smoke", { path: page }, "cli");
    expect(r.allowed).toBe(true);
  });

  it("サンドボックス外のページは許可しない", async () => {
    const pm = new PermissionManager(mkConfig());
    pm.setAutorunMode(true);
    const outside = process.platform === "win32" ? "C:\\Windows\\evil.html" : "/etc/evil.html";
    const r = await pm.checkToolPermission("game_smoke", { path: outside }, "cli");
    expect(r.allowed).toBe(false);
  });
});
