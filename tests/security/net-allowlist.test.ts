import { describe, it, expect } from "vitest";
import {
  DEFAULT_ALLOWED_DOMAINS,
  normalizeHost,
  domainAllowed,
  addDomain,
} from "../../src/security/net-allowlist.js";

describe("normalizeHost", () => {
  it("scheme/port/path を除去し小文字化", () => {
    expect(normalizeHost("https://Registry.NPMjs.org:443/foo")).toBe("registry.npmjs.org");
    expect(normalizeHost("github.com:443")).toBe("github.com");
    expect(normalizeHost("PyPI.org")).toBe("pypi.org");
  });
});

describe("domainAllowed", () => {
  const allow = ["registry.npmjs.org", "*.githubusercontent.com"];
  it("完全一致を許可", () => {
    expect(domainAllowed("registry.npmjs.org", allow)).toBe(true);
    expect(domainAllowed("https://registry.npmjs.org:443/x", allow)).toBe(true);
  });
  it("ワイルドカードはサブドメインに合致", () => {
    expect(domainAllowed("raw.githubusercontent.com", allow)).toBe(true);
    expect(domainAllowed("objects.githubusercontent.com:443", allow)).toBe(true);
  });
  it("ワイルドカードはベアドメインには合致しない", () => {
    expect(domainAllowed("githubusercontent.com", allow)).toBe(false);
  });
  it("未許可は false", () => {
    expect(domainAllowed("evil.example.com", allow)).toBe(false);
    expect(domainAllowed("notnpmjs.org", allow)).toBe(false);
  });
  it('"*" は全許可', () => {
    expect(domainAllowed("anything.example.com", ["*"])).toBe(true);
  });
  it("既定リストで npm/pip/github が通る", () => {
    for (const d of ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "github.com", "codeload.github.com"]) {
      expect(domainAllowed(d, DEFAULT_ALLOWED_DOMAINS)).toBe(true);
    }
    expect(domainAllowed("raw.githubusercontent.com", DEFAULT_ALLOWED_DOMAINS)).toBe(true);
  });
});

describe("addDomain", () => {
  it("正規化して追加", () => {
    expect(addDomain([], "https://Example.com:443/x")).toEqual(["example.com"]);
  });
  it("重複は追加しない", () => {
    expect(addDomain(["example.com"], "example.com")).toEqual(["example.com"]);
  });
  it("ワイルドカードはそのまま保持", () => {
    expect(addDomain([], "*.example.com")).toEqual(["*.example.com"]);
  });
});
