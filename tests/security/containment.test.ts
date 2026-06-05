import { describe, it, expect, vi, beforeEach } from "vitest";

// 封じ込め判定 isBashNetworkContained のゲーティングを検証する（Phase 3・§7.2）。
// 依存（platform / proxy 構成 / config）をモックして条件分岐を網羅。
// ProcessSandbox は実物を使う（このテストは darwin 上で走り sandbox-exec があるため fs→fs）。

const h = vi.hoisted(() => ({
  isMacOS: true,
  proxy: {} as object | null,
  level: "fs" as "none" | "fs" | "network" | "full",
  autoAllow: undefined as boolean | undefined,
}));

vi.mock("../../src/utils/platform.js", () => ({
  get isMacOS() {
    return h.isMacOS;
  },
  isWindows: false,
  isLinux: false,
}));
vi.mock("../../src/security/sandbox-proxy.js", () => ({
  getSandboxProxy: () => h.proxy,
}));
vi.mock("../../src/config/config-manager.js", () => ({
  loadConfig: () => ({
    security: {
      processSandbox: { enabled: true, level: h.level, autoAllowBashWhenContained: h.autoAllow },
    },
  }),
}));

import { isBashNetworkContained } from "../../src/security/containment.js";
import { resetActiveProcessSandbox } from "../../src/security/active-sandbox.js";

describe("isBashNetworkContained (Phase 3 ゲート)", () => {
  beforeEach(() => {
    h.isMacOS = true;
    h.proxy = {};
    h.level = "fs";
    h.autoAllow = undefined;
    resetActiveProcessSandbox(); // config キャッシュを破棄して各ケースの h を反映させる
  });

  it("macOS + proxy + fs + 既定 → true", () => {
    expect(isBashNetworkContained()).toBe(true);
  });
  it("autoAllowBashWhenContained=false（オプトアウト） → false", () => {
    h.autoAllow = false;
    expect(isBashNetworkContained()).toBe(false);
  });
  it("proxy 未構成 → false", () => {
    h.proxy = null;
    expect(isBashNetworkContained()).toBe(false);
  });
  it("macOS でない → false（封じ込め実証は macOS のみ）", () => {
    h.isMacOS = false;
    expect(isBashNetworkContained()).toBe(false);
  });
  it("level=none → false", () => {
    h.level = "none";
    expect(isBashNetworkContained()).toBe(false);
  });
  it("level=full（ネット全遮断）→ false（fs のみ対象）", () => {
    h.level = "full";
    expect(isBashNetworkContained()).toBe(false);
  });
});
