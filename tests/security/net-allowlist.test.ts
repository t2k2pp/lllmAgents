import { describe, it, expect } from "vitest";
import {
  DEFAULT_ALLOWED_DOMAINS,
  normalizeHost,
  domainAllowed,
  addDomain,
  removeDomain,
  resolveAllowedDomains,
} from "../../src/security/net-allowlist.js";

describe("normalizeHost", () => {
  it("scheme/port/path を除去し小文字化", () => {
    expect(normalizeHost("https://Registry.NPMjs.org:443/foo")).toBe("registry.npmjs.org");
    expect(normalizeHost("github.com:443")).toBe("github.com");
    expect(normalizeHost("PyPI.org")).toBe("pypi.org");
  });
  it("userinfo (user@) を除去して迂回を防ぐ", () => {
    // evil.com@github.com は「github.com への接続」と解釈されねばならない
    expect(normalizeHost("evil.com@github.com")).toBe("github.com");
    expect(normalizeHost("http://user:pass@example.com:8080/x")).toBe("example.com");
  });
  it("末尾ドット(FQDN)を除去", () => {
    expect(normalizeHost("github.com.")).toBe("github.com");
  });
  it("IPv6: ブラケットを剥がし、 裸の多コロン表記を壊さない", () => {
    expect(normalizeHost("[::1]:443")).toBe("::1");
    expect(normalizeHost("2001:db8::1")).toBe("2001:db8::1");
  });
  it("IDN(非ASCII) は punycode へ正規化（ホモグラフ対策）", () => {
    // 日本語ドメイン例: そのまま xn-- へ
    expect(normalizeHost("日本語.jp")).toMatch(/^xn--/);
    // キリル 'а' を含む偽 github は ASCII の github.com と一致しない
    expect(normalizeHost("gаithub.com")).not.toBe("github.com");
    expect(normalizeHost("gаithub.com")).toMatch(/^xn--/);
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

describe("removeDomain", () => {
  it("正規化して一致するものを除去", () => {
    expect(removeDomain(["example.com", "github.com"], "https://Example.com:443")).toEqual(["github.com"]);
  });
  it("ワイルドカードも除去できる", () => {
    expect(removeDomain(["*.example.com", "github.com"], "*.example.com")).toEqual(["github.com"]);
  });
  it("無い物を消そうとしても不変", () => {
    expect(removeDomain(["github.com"], "absent.com")).toEqual(["github.com"]);
  });
});

describe("resolveAllowedDomains", () => {
  it("undefined(未設定) は既定プリセットへ", () => {
    expect(resolveAllowedDomains(undefined)).toEqual(DEFAULT_ALLOWED_DOMAINS);
  });
  it("[](明示的な空) は空のまま（既定に戻さない）", () => {
    expect(resolveAllowedDomains([])).toEqual([]);
  });
  it("設定値はそのまま", () => {
    expect(resolveAllowedDomains(["a.com"])).toEqual(["a.com"]);
  });
});
