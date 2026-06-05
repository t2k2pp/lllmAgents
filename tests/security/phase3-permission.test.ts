import { describe, it, expect, vi } from "vitest";
import type { SecurityConfig } from "../../src/config/types.js";

// Phase 3: 封じ込め時に bash 実行確認が自動許可される（autorun トグル無しで）ことを検証。
// containment 判定をモックして「封じ込め下」を再現し、 permission-manager の挙動を確認する。

vi.mock("../../src/security/containment.js", () => ({
  isBashNetworkContained: () => true,
}));

import { PermissionManager } from "../../src/security/permission-manager.js";

function mkConfig(): SecurityConfig {
  return {
    allowedDirectories: [process.cwd()],
    autoApproveTools: [], // bash は自動承認リストに入れない（=本来は確認が要る）
    requireApprovalTools: [],
    rules: { allow: [], deny: [], ask: [] },
  } as unknown as SecurityConfig;
}

describe("Phase 3: 封じ込め下の bash 自動許可", () => {
  it("非破壊 bash (echo) は確認なしで許可される", async () => {
    const pm = new PermissionManager(mkConfig());
    const r = await pm.checkToolPermission("bash", { command: "echo hi" }, "cli");
    expect(r.allowed).toBe(true);
  });

  it("CWD 内のビルドコマンドも許可される", async () => {
    const pm = new PermissionManager(mkConfig());
    const r = await pm.checkToolPermission("bash", { command: "npm run build" }, "cli");
    expect(r.allowed).toBe(true);
  });

  it("deny ルールは封じ込め下でも優先される（自動許可しない）", async () => {
    const cfg = mkConfig();
    cfg.rules = { allow: [], deny: ["bash(curl *)"], ask: [] };
    const pm = new PermissionManager(cfg);
    const r = await pm.checkToolPermission("bash", { command: "curl https://example.com" }, "cli");
    expect(r.allowed).toBe(false);
  });
});
