import { describe, it, expect, afterEach } from "vitest";
import {
  probeBrowserCapability,
  getBrowserCapability,
} from "../../src/browser/browser-capability.js";
import type { Config } from "../../src/config/types.js";

// capability ゲートの「強制制御」（env / config）を固定する回帰テスト。
// docs/exe-playwright-externalization.md §B。auto プローブ（実 playwright 解決）は
// 環境依存のためここでは強制パスのみを対象にする。

const cfg = (browser?: "auto" | "on" | "off"): Config =>
  ({ features: { browser } }) as unknown as Config;

afterEach(() => {
  delete process.env.LOCALLLM_NO_BROWSER;
  delete process.env.LOCALLLM_FORCE_BROWSER;
});

describe("probeBrowserCapability — 強制制御", () => {
  it("features.browser=off で無効（ツール非登録側）", async () => {
    const c = await probeBrowserCapability(cfg("off"));
    expect(c.ready).toBe(false);
    expect(c.source).toBe("forced-off");
  });

  it("features.browser=on で強制有効", async () => {
    const c = await probeBrowserCapability(cfg("on"));
    expect(c.ready).toBe(true);
    expect(c.source).toBe("forced-on");
  });

  it("env LOCALLLM_NO_BROWSER は config より優先して無効化", async () => {
    process.env.LOCALLLM_NO_BROWSER = "1";
    const c = await probeBrowserCapability(cfg("on")); // config は on でも env off が勝つ
    expect(c.ready).toBe(false);
    expect(c.source).toBe("forced-off");
  });

  it("getBrowserCapability は直近の判定結果を返す", async () => {
    await probeBrowserCapability(cfg("off"));
    expect(getBrowserCapability().ready).toBe(false);
    await probeBrowserCapability(cfg("on"));
    expect(getBrowserCapability().ready).toBe(true);
  });
});
