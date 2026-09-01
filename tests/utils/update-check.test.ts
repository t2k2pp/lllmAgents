import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseSemver,
  isNewerVersion,
  inspectUpdate,
  checkForUpdate,
  formatUpdateInspection,
} from "../../src/utils/update-check.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSemver / isNewerVersion", () => {
  it("v プレフィックスあり/なしをパースする", () => {
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("0.4.0")).toEqual([0, 4, 0]);
    expect(parseSemver("pre-goal-seek-mode")).toBeNull();
    expect(parseSemver("v1.2")).toBeNull();
  });

  it("semver で新旧を比較する", () => {
    expect(isNewerVersion("v0.5.0", "0.4.0")).toBe(true);
    expect(isNewerVersion("v1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("v0.4.0", "0.4.0")).toBe(false);
    expect(isNewerVersion("v0.3.9", "0.4.0")).toBe(false);
    // パース不能タグは「新しい」と誤判定しない
    expect(isNewerVersion("pre-goal-seek-mode", "0.4.0")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  it("新しいリリースと配布物があれば通知文を返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v9.9.9",
          html_url: "https://example.invalid/releases/v9.9.9",
          assets: [{ name: "localllm-win32-x64.zip", browser_download_url: "https://example.invalid/app.zip" }],
        }),
      }),
    );
    const notice = await checkForUpdate("0.4.0");
    expect(notice).toContain("v9.9.9");
    expect(notice).toContain("0.4.0");
  });

  it("最新版を使っていれば null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v0.4.0",
          assets: [{ name: "localllm.zip", browser_download_url: "https://example.invalid/app.zip" }],
        }),
      }),
    );
    expect(await checkForUpdate("0.4.0")).toBeNull();
  });

  it("background通知ではAPIエラー・ネットワーク失敗を通知に偽装しない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await checkForUpdate("0.4.0")).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await checkForUpdate("0.4.0")).toBeNull();
  });

  it("公開版が新しくても配布物が無ければ明示診断で blocked にする", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v0.4.1",
          html_url: "https://example.invalid/releases/v0.4.1",
          assets: [],
        }),
      }),
    );

    const result = await inspectUpdate("0.4.0");
    expect(result.status).toBe("blocked");
    expect(formatUpdateInspection(result)).toContain("配布物がありません");
    expect(await checkForUpdate("0.4.0")).toContain("配布物がありません");
  });

  it("明示診断では到達不能を unavailable と理由付きで返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const result = await inspectUpdate("0.4.1");
    expect(result.status).toBe("unavailable");
    expect(result.detail).toContain("offline");
    expect(JSON.parse(formatUpdateInspection(result, { json: true }))).toMatchObject({
      status: "unavailable",
      currentVersion: "0.4.1",
    });
  });
});
