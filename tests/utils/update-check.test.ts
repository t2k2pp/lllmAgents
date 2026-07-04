import { describe, it, expect, vi, afterEach } from "vitest";
import { parseSemver, isNewerVersion, checkForUpdate } from "../../src/utils/update-check.js";

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
  it("新しいリリースがあれば通知文を返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v9.9.9" }),
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
        json: async () => ({ tag_name: "v0.4.0" }),
      }),
    );
    expect(await checkForUpdate("0.4.0")).toBeNull();
  });

  it("API エラー・ネットワーク失敗は黙って null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await checkForUpdate("0.4.0")).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await checkForUpdate("0.4.0")).toBeNull();
  });
});
