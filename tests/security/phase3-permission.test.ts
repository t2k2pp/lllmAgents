import { describe, it, expect, vi } from "vitest";
import type { SecurityConfig } from "../../src/config/types.js";

// Phase 3: 封じ込め時に bash 実行確認が自動許可される（autorun トグル無しで）ことを検証。
// containment 判定をモックして「封じ込め下」を再現し、 permission-manager の挙動を確認する。

vi.mock("../../src/security/containment.js", () => ({
  isBashNetworkContained: () => true,
}));

import { PermissionManager } from "../../src/security/permission-manager.js";
import { nonTTYReader } from "../../src/utils/non-tty-reader.js";

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

  it("getContainmentAutoAllowCount が自動許可回数を数える（W3 可観測）", async () => {
    const pm = new PermissionManager(mkConfig());
    expect(pm.getContainmentAutoAllowCount()).toBe(0);
    await pm.checkToolPermission("bash", { command: "echo a" }, "cli");
    await pm.checkToolPermission("bash", { command: "echo b" }, "cli");
    expect(pm.getContainmentAutoAllowCount()).toBe(2);
  });

  it("deny ルールは封じ込め下でも優先される（自動許可しない）", async () => {
    const cfg = mkConfig();
    cfg.rules = { allow: [], deny: ["bash(curl *)"], ask: [] };
    const pm = new PermissionManager(cfg);
    const r = await pm.checkToolPermission("bash", { command: "curl https://example.com" }, "cli");
    expect(r.allowed).toBe(false);
  });

  // #3 Phase3 の核心: 封じ込め下でも破壊的コマンドは自動許可されず「確認フロー」へ落ちる。
  // 確認フロー到達は nonTTYReader.readLine が呼ばれることで判定（"4"=拒否を返させる）。
  describe("破壊的/危険コマンドは封じ込め下でも確認へフォールバック", () => {
    let readSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      readSpy = vi.spyOn(nonTTYReader, "readLine").mockResolvedValue("4"); // 4=拒否
    });
    afterEach(() => readSpy.mockRestore());

    it("非破壊 bash は確認に落ちず自動許可（readLine は呼ばれない）", async () => {
      const pm = new PermissionManager(mkConfig());
      const r = await pm.checkToolPermission("bash", { command: "echo hi" }, "cli");
      expect(r.allowed).toBe(true);
      expect(readSpy).not.toHaveBeenCalled();
    });

    it.each([
      "git push -f origin feature", // main/master block には当たらない force push
      "git checkout .",
      "git clean -fdx",
      "rm -rf build",
      "chmod -R 000 .",
    ])("破壊的 %s は自動許可されず確認へ落ちる（readLine が呼ばれ拒否）", async (command) => {
      const pm = new PermissionManager(mkConfig());
      const r = await pm.checkToolPermission("bash", { command }, "cli");
      expect(readSpy).toHaveBeenCalled(); // ask フローに到達した＝自動許可されていない
      expect(r.allowed).toBe(false); // 拒否("4")
    });
  });
});
