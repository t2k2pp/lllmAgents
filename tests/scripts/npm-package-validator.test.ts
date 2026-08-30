import { describe, expect, it } from "vitest";
import {
  MAX_PACKAGE_FILES,
  MAX_UNPACKED_BYTES,
  selectPackReport,
  validatePackReport,
} from "../../scripts/validate-npm-package.mjs";

describe("npm package validator", () => {
  it("runtime filesだけの小さいpackageを許可する", () => {
    expect(
      validatePackReport({
        files: [{ path: "dist/index.js" }, { path: "src/skills/builtin/tdd/SKILL.md" }],
        unpackedSize: 1024,
      }),
    ).toEqual([]);
  });

  it.each([
    "dist/localllm.exe",
    "dist/sea-prep.blob",
    "tests/e2e.test.js",
    "sandbox/demo.txt",
  ])("配布禁止ファイル %s を拒否する", (path) => {
    expect(validatePackReport({ files: [{ path }], unpackedSize: 1024 })[0]).toContain(path);
  });

  it("ファイル数と展開サイズの上限超過を拒否する", () => {
    const files = Array.from({ length: MAX_PACKAGE_FILES + 1 }, (_, index) => ({ path: `dist/${index}.js` }));
    const errors = validatePackReport({ files, unpackedSize: MAX_UNPACKED_BYTES + 1 });
    expect(errors).toHaveLength(2);
  });

  it("npmの配列形式とpackage名キー形式の両方からreportを選ぶ", () => {
    const report = { files: [], unpackedSize: 0 };
    expect(selectPackReport([report])).toBe(report);
    expect(selectPackReport({ "localllm-agents": report })).toBe(report);
  });
});
