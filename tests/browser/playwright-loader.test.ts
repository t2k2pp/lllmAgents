import { describe, it, expect, vi } from "vitest";
import { resolvePlaywright, PlaywrightNotInstalledError } from "../../src/browser/playwright-manager.js";

// resolvePlaywright のロジック（docs/exe-playwright-externalization.md §3.2）を
// 実ブラウザ無しで固定する回帰テスト。import 成功/失敗、解決順、未導入時 null を検証。

const fakePw = { chromium: { launch: () => {} } } as unknown as typeof import("playwright");

describe("resolvePlaywright", () => {
  it("import が成功すればそれを返す（dev/tsx 経路）", async () => {
    const importFn = vi.fn(async () => fakePw);
    const makeRequire = vi.fn(() => () => {
      throw new Error("should not be called");
    });
    const mod = await resolvePlaywright(importFn, ["/home/.localllm", "/cwd"], makeRequire);
    expect(mod).toBe(fakePw);
    expect(makeRequire).not.toHaveBeenCalled();
  });

  it("import 失敗時は roots を順に試し、最初に解決できたものを返す", async () => {
    const importFn = vi.fn(async () => {
      throw new Error("Cannot find module 'playwright'"); // exe/SEA/ラッパ相当
    });
    // 1つ目の root は失敗、2つ目で成功 → 解決順を検証
    const makeRequire = (from: string) => (id: string) => {
      expect(id).toBe("playwright");
      if (from.startsWith("/home/.localllm")) throw new Error("not installed here");
      return fakePw;
    };
    const mod = await resolvePlaywright(importFn, ["/home/.localllm", "/cwd"], makeRequire);
    expect(mod).toBe(fakePw);
  });

  it("~/.localllm を CWD より優先する", async () => {
    const importFn = vi.fn(async () => {
      throw new Error("no bundle");
    });
    const home = { chromium: { launch: () => {} } } as unknown as typeof import("playwright");
    const cwd = { chromium: { launch: () => {} } } as unknown as typeof import("playwright");
    const makeRequire = (from: string) => () =>
      from.startsWith("/home/.localllm") ? home : cwd;
    const mod = await resolvePlaywright(importFn, ["/home/.localllm", "/cwd"], makeRequire);
    expect(mod).toBe(home);
  });

  it("import も roots も全滅なら null（呼び出し側で未導入エラー化）", async () => {
    const importFn = vi.fn(async () => {
      throw new Error("no bundle");
    });
    const makeRequire = () => () => {
      throw new Error("not found");
    };
    const mod = await resolvePlaywright(importFn, ["/home/.localllm", "/cwd"], makeRequire);
    expect(mod).toBeNull();
  });

  it("chromium プロパティが無いモジュールは無効として扱う", async () => {
    const importFn = vi.fn(async () => ({}) as unknown as typeof import("playwright"));
    const makeRequire = () => () => ({}) as unknown;
    const mod = await resolvePlaywright(importFn, ["/home/.localllm"], makeRequire);
    expect(mod).toBeNull();
  });

  it("PlaywrightNotInstalledError は正しい導入コマンドを案内する", () => {
    const e = new PlaywrightNotInstalledError();
    // --setup ではなく --install-browser（--setup に導入は配線していないため。P0-3 是正）
    expect(e.message).toContain("--install-browser");
    expect(e.message).not.toContain("--setup");
  });
});
