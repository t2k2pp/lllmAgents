import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityConfig } from "../../src/config/types.js";
import { PermissionManager } from "../../src/security/permission-manager.js";
import { nonTTYReader } from "../../src/utils/non-tty-reader.js";

function config(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    allowedDirectories: [process.cwd()],
    autoApproveTools: ["computer_click", "computer_screenshot"],
    requireApprovalTools: [],
    discordAutoApproveTools: ["computer_click"],
    slackAutoApproveTools: ["computer_click"],
    rules: { allow: ["computer_click(*)"], deny: [], ask: [] },
    ...overrides,
  } as SecurityConfig;
}

afterEach(() => vi.restoreAllMocks());

describe("native computer use permission boundary", () => {
  it.each(["discord", "slack"] as const)("%sでは明示allow設定があっても強制拒否", async (source) => {
    const pm = new PermissionManager(config());
    const result = await pm.checkToolPermission("computer_click", { window_id: "w", x: 1, y: 2 }, source);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("CLI");
  });

  it("CLI autorun・autoApprove・allow ruleでも一回確認を省略しない", async () => {
    const readLine = vi.spyOn(nonTTYReader, "readLine").mockResolvedValue("2");
    const pm = new PermissionManager(config());
    pm.setAutorunMode(true);
    const result = await pm.checkToolPermission("computer_click", { window_id: "w", x: 1, y: 2 }, "cli");
    expect(readLine).toHaveBeenCalledOnce();
    expect(result.allowed).toBe(false);
  });

  it("一回許可を選んでも同じ操作を再度確認する", async () => {
    const readLine = vi.spyOn(nonTTYReader, "readLine").mockResolvedValue("1");
    const pm = new PermissionManager(config());
    expect((await pm.checkToolPermission("computer_click", { window_id: "w", x: 1, y: 2 }, "cli")).allowed).toBe(true);
    expect((await pm.checkToolPermission("computer_click", { window_id: "w", x: 1, y: 2 }, "cli")).allowed).toBe(true);
    expect(readLine).toHaveBeenCalledTimes(2);
  });

  it("deny ruleは確認より優先する", async () => {
    const readLine = vi.spyOn(nonTTYReader, "readLine").mockResolvedValue("1");
    const pm = new PermissionManager(config({ rules: { allow: [], deny: ["computer_click(*)"], ask: [] } }));
    const result = await pm.checkToolPermission("computer_click", { window_id: "w", x: 1, y: 2 }, "cli");
    expect(result.allowed).toBe(false);
    expect(readLine).not.toHaveBeenCalled();
  });
});
