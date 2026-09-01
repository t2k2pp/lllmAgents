import { describe, expect, it } from "vitest";
import { validateVersionState } from "../../scripts/version-policy.js";

const valid = {
  packageVersion: "0.4.1",
  lockVersion: "0.4.1",
  lockRootVersion: "0.4.1",
  changelog: "## [Unreleased]\n\n## [0.4.1] - 2026-08-13\n",
};

describe("release version policy", () => {
  it("3桁SemVer・lockfile・CHANGELOGが一致すれば受理する", () => {
    expect(validateVersionState(valid)).toEqual([]);
  });

  it("4番目の数値は公開版として受理せずbuild identityと分離させる", () => {
    expect(validateVersionState({ ...valid, packageVersion: "0.4.1.7" })).toContain(
      "package.json version は MAJOR.MINOR.PATCH の3桁SemVerにしてください: 0.4.1.7",
    );
  });

  it("manifest・lockfile・release tagの不一致をすべて検出する", () => {
    const errors = validateVersionState({
      ...valid,
      lockVersion: "0.4.0",
      lockRootVersion: "0.4.0",
      releaseTag: "v0.4.0",
    });
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toContain("package-lock.json version");
    expect(errors.join("\n")).toContain("release tag v0.4.0");
  });

  it("CHANGELOGに対象リリースが無ければ拒否する", () => {
    expect(validateVersionState({ ...valid, changelog: "## [Unreleased]\n" })).toContain(
      "CHANGELOG.md に ## [0.4.1] のリリース項目がありません",
    );
  });
});
