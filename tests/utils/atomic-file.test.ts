import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeFileAtomic, hardenFilePermissions } from "../../src/utils/atomic-file.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-file-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("新規ファイルを書き込める", () => {
    const file = path.join(dir, "a.json");
    writeFileAtomic(file, '{"x":1}');
    expect(fs.readFileSync(file, "utf-8")).toBe('{"x":1}');
  });

  it("既存ファイルを丸ごと差し替える", () => {
    const file = path.join(dir, "a.json");
    fs.writeFileSync(file, "old-content-that-is-longer");
    writeFileAtomic(file, "new");
    expect(fs.readFileSync(file, "utf-8")).toBe("new");
  });

  it("親ディレクトリが無ければ作る", () => {
    const file = path.join(dir, "sub", "deep", "a.json");
    writeFileAtomic(file, "x");
    expect(fs.readFileSync(file, "utf-8")).toBe("x");
  });

  it("書き込み後に一時ファイルを残さない", () => {
    const file = path.join(dir, "a.json");
    writeFileAtomic(file, "x");
    expect(fs.readdirSync(dir)).toEqual(["a.json"]);
  });
});

describe("hardenFilePermissions", () => {
  it("存在しないファイルは false", () => {
    expect(hardenFilePermissions(path.join(dir, "nope"))).toBe(false);
  });

  it("存在するファイルで成功する", () => {
    const file = path.join(dir, "secret.json");
    fs.writeFileSync(file, "{}");
    expect(hardenFilePermissions(file)).toBe(true);
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
