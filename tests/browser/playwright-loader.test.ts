import { describe, it, expect, vi } from "vitest";
import { resolvePlaywright, PlaywrightNotInstalledError } from "../../src/browser/playwright-manager.js";

// resolvePlaywright のロジック（docs/exe-playwright-externalization.md §3.2）を
// 実ブラウザ無しで固定する回帰テスト。
// 新方針 (2026-06): 「読めた最初のもの」ではなく「対応 Chromium が実在するもの」を優先し、
// 無ければ読めた最初のものにフォールバックする。chromiumPresent を注入して fs に依存せず検証する。

const mk = () => ({ chromium: { launch: () => {} } }) as unknown as typeof import("playwright");
const present = () => true;
const absent = () => false;

describe("resolvePlaywright", () => {
  it("Chromium が実在する import モジュールは即返す（roots を見ない）", async () => {
    const pw = mk();
    const importFn = vi.fn(async () => pw);
    const makeRequire = vi.fn(() => () => {
      throw new Error("should not be called");
    });
    const mod = await resolvePlaywright(importFn, ["/home/.localllm", "/cwd"], makeRequire, present);
    expect(mod).toBe(pw);
    expect(makeRequire).not.toHaveBeenCalled();
  });

  it("import の Chromium が実在しなければ roots を探し、Chromium 実在のものを優先する", async () => {
    const importMod = mk(); // 読めるが Chromium 無し
    const homeMod = mk(); // 読めるが Chromium 無し
    const cwdMod = mk(); // Chromium 実在
    const importFn = vi.fn(async () => importMod);
    // path.join により from の区切りは OS 依存 (Windows は \)。区切り非依存で判定する。
    const makeRequire = (from: string) => () =>
      from.includes(".localllm") ? homeMod : cwdMod;
    const chromiumPresent = (m: typeof import("playwright")) => m === cwdMod;
    const mod = await resolvePlaywright(importFn, ["/home/.localllm", "/cwd"], makeRequire, chromiumPresent);
    expect(mod).toBe(cwdMod); // 動くペアを再利用
  });

  it("Chromium 実在が複数なら ~/.localllm を CWD より優先する", async () => {
    const importFn = vi.fn(async () => {
      throw new Error("no bundle");
    });
    const home = mk();
    const cwd = mk();
    const makeRequire = (from: string) => () => (from.includes(".localllm") ? home : cwd);
    const mod = await resolvePlaywright(importFn, ["/home/.localllm", "/cwd"], makeRequire, present);
    expect(mod).toBe(home);
  });

  it("Chromium 実在の候補が無ければ、読めた最初のものを返す（probe が未導入を報告できる）", async () => {
    const importMod = mk();
    const importFn = vi.fn(async () => importMod);
    const homeMod = mk();
    const makeRequire = () => () => homeMod;
    const mod = await resolvePlaywright(importFn, ["/home/.localllm"], makeRequire, absent);
    expect(mod).toBe(importMod); // 最初に読めたもの（import）
  });

  it("import 失敗かつ Chromium 実在なし時は、読めた最初の root を返す", async () => {
    const importFn = vi.fn(async () => {
      throw new Error("no bundle");
    });
    const homeMod = mk();
    const makeRequire = (from: string) => () => {
      if (from.includes(".localllm")) return homeMod;
      throw new Error("not here");
    };
    const mod = await resolvePlaywright(importFn, ["/home/.localllm", "/cwd"], makeRequire, absent);
    expect(mod).toBe(homeMod);
  });

  it("import も roots も全滅なら null（呼び出し側で未導入エラー化）", async () => {
    const importFn = vi.fn(async () => {
      throw new Error("no bundle");
    });
    const makeRequire = () => () => {
      throw new Error("not found");
    };
    const mod = await resolvePlaywright(importFn, ["/home/.localllm", "/cwd"], makeRequire, present);
    expect(mod).toBeNull();
  });

  it("chromium プロパティが無いモジュールは無効として扱う", async () => {
    const importFn = vi.fn(async () => ({}) as unknown as typeof import("playwright"));
    const makeRequire = () => () => ({}) as unknown;
    const mod = await resolvePlaywright(importFn, ["/home/.localllm"], makeRequire, present);
    expect(mod).toBeNull();
  });

  it("PlaywrightNotInstalledError は正しい導入コマンドを案内する", () => {
    const e = new PlaywrightNotInstalledError();
    expect(e.message).toContain("--install-browser");
    expect(e.message).not.toContain("--setup");
  });
});
