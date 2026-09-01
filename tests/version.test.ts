import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { APP_VERSION, getAppCommit, getVersionString } from "../src/version.js";

const require = createRequire(import.meta.url);
const manifest = require("../package.json") as { version: string };

describe("application version identity", () => {
  it("package.jsonを公開SemVerの単一ソースとして使う", () => {
    expect(APP_VERSION).toBe(manifest.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("表示では3桁の公開版とbuild identityを分離する", () => {
    expect(getAppCommit()).not.toBe("unknown");
    expect(getVersionString()).toMatch(
      new RegExp(`^v${APP_VERSION.replaceAll(".", "\\.")} \\(build [0-9a-f]+(?:-dirty)?\\)$`),
    );
  });
});
