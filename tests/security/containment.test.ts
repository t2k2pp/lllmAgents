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
import { resetActiveProcessSandbox, reconcileSandboxProxy } from "../../src/security/active-sandbox.js";

describe("isBashNetworkContained (Phase 3 ゲート)", () => {
  beforeEach(() => {
    h.isMacOS = true;
    h.proxy = {};
    h.level = "fs";
    h.autoAllow = undefined;
    resetActiveProcessSandbox(); // config キャッシュを破棄して各ケースの h を反映させる
  });

  // 実物 ProcessSandbox が fs を返す環境 (darwin=sandbox-exec / linux=bwrap) が前提。
  // Windows ネイティブは effective level が常に none のため封じ込め自体が対象外 → skip。
  it.skipIf(process.platform === "win32")("macOS + proxy + fs + 既定 → true", () => {
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

describe("reconcileSandboxProxy (D: proxy ライフサイクル単一窓口)", () => {
  beforeEach(() => {
    h.isMacOS = true;
    resetActiveProcessSandbox();
  });
  // fs 維持の判定も実物 ProcessSandbox の effective level に依存 → Windows は skip (上と同じ理由)
  it.skipIf(process.platform === "win32")("fs + macOS は proxy を止めない（要るので維持）", () => {
    const stop = vi.fn();
    h.level = "fs";
    h.proxy = { stop };
    resetActiveProcessSandbox();
    reconcileSandboxProxy();
    expect(stop).not.toHaveBeenCalled();
  });
  it("full は proxy を止める（ネット全遮断＝proxy 不要）", () => {
    const stop = vi.fn();
    h.level = "full";
    h.proxy = { stop };
    resetActiveProcessSandbox();
    reconcileSandboxProxy();
    expect(stop).toHaveBeenCalled();
  });
  it("none（封じ込め OFF 相当）は proxy を止める", () => {
    const stop = vi.fn();
    h.level = "none";
    h.proxy = { stop };
    resetActiveProcessSandbox();
    reconcileSandboxProxy();
    expect(stop).toHaveBeenCalled();
  });
});
