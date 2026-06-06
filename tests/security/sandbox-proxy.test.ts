import { describe, it, expect, vi } from "vitest";
import { SandboxProxy, parseConnectPort, isBlockedAddress, type DomainDecision } from "../../src/security/sandbox-proxy.js";

describe("parseConnectPort", () => {
  it("host:port から port、 無指定は 443", () => {
    expect(parseConnectPort("example.com:443")).toBe(443);
    expect(parseConnectPort("example.com:8443")).toBe(8443);
    expect(parseConnectPort("example.com")).toBe(443);
  });
  it("IPv6 を誤解しない（[..]:port と裸 IPv6）", () => {
    expect(parseConnectPort("[::1]:443")).toBe(443);
    expect(parseConnectPort("[2001:db8::1]:8443")).toBe(8443);
    expect(parseConnectPort("[::1]")).toBe(443);
    // 裸 IPv6（多コロン）は末尾 :1 を port と誤認せず既定 443
    expect(parseConnectPort("2001:db8::1")).toBe(443);
  });
});

describe("isBlockedAddress (SSRF/内部レンジ遮断)", () => {
  it("loopback / link-local(メタデータ) / RFC1918 を遮断", () => {
    for (const ip of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.1.1", "0.0.0.0"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("グローバル IPv4 は許可", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "140.82.121.3"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });
  it("172.15/172.32 は RFC1918 外なので許可", () => {
    expect(isBlockedAddress("172.15.0.1")).toBe(false);
    expect(isBlockedAddress("172.32.0.1")).toBe(false);
  });
  it("IPv6: ::1 / fe80 / ULA / v4-mapped 内部 を遮断、 グローバルは許可", () => {
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fd00::1")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });
  it("IPv6 展開表記の loopback/unspecified も遮断 (文字列一致でなく数値判定)", () => {
    expect(isBlockedAddress("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isBlockedAddress("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(true);
    expect(isBlockedAddress("::")).toBe(true);
    expect(isBlockedAddress("0:0:0:0:0:0:0:0")).toBe(true);
  });
  it("16進 v4-mapped・NAT64・site-local も内部なら遮断", () => {
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true); // v4-mapped 127.0.0.1 (16進)
    expect(isBlockedAddress("64:ff9b::7f00:1")).toBe(true); // NAT64 → 127.0.0.1
    expect(isBlockedAddress("fec0::1")).toBe(true); // site-local
  });
  it("CGNAT 100.64/10 を遮断、 100.63/100.128 は許可", () => {
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
    expect(isBlockedAddress("100.127.255.1")).toBe(true);
    expect(isBlockedAddress("100.63.0.1")).toBe(false);
    expect(isBlockedAddress("100.128.0.1")).toBe(false);
  });
  it("ブラケット付き IPv6 リテラルも判定できる", () => {
    expect(isBlockedAddress("[::1]")).toBe(true);
    expect(isBlockedAddress("[2606:4700:4700::1111]")).toBe(false);
  });
  it("解決不能な値は安全側で遮断", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

function mk(opts: { allowed?: string[]; decision?: DomainDecision }) {
  const persistDomain = vi.fn();
  const onUnknownDomain = vi.fn(async (_h: string): Promise<DomainDecision> => opts.decision ?? "deny");
  const proxy = new SandboxProxy({
    getAllowedDomains: () => opts.allowed ?? [],
    onUnknownDomain,
    persistDomain,
  });
  return { proxy, persistDomain, onUnknownDomain };
}

describe("SandboxProxy.authorize", () => {
  it("allowlist にあれば確認せず許可", async () => {
    const { proxy, onUnknownDomain } = mk({ allowed: ["example.com"] });
    expect(await proxy.authorize("example.com")).toBe(true);
    expect(onUnknownDomain).not.toHaveBeenCalled();
  });

  it("未許可 + deny → 拒否", async () => {
    const { proxy } = mk({ decision: "deny" });
    expect(await proxy.authorize("evil.example.org")).toBe(false);
  });

  it("未許可 + once → 許可・persist せず・2回目は確認しない", async () => {
    const { proxy, persistDomain, onUnknownDomain } = mk({ decision: "once" });
    expect(await proxy.authorize("new.com")).toBe(true);
    expect(persistDomain).not.toHaveBeenCalled();
    expect(await proxy.authorize("new.com")).toBe(true);
    expect(onUnknownDomain).toHaveBeenCalledTimes(1); // セッション許可で2回目は聞かない
  });

  it("未許可 + always → 許可 + persist", async () => {
    const { proxy, persistDomain } = mk({ decision: "always" });
    expect(await proxy.authorize("save.com")).toBe(true);
    expect(persistDomain).toHaveBeenCalledWith("save.com");
  });

  it("同一ホストの並行確認は1回に集約", async () => {
    const { proxy, onUnknownDomain } = mk({ decision: "once" });
    const [a, b] = await Promise.all([proxy.authorize("x.com"), proxy.authorize("x.com")]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(onUnknownDomain).toHaveBeenCalledTimes(1);
  });

  it("ワイルドカード allowlist に従う", async () => {
    const { proxy, onUnknownDomain } = mk({ allowed: ["*.example.com"] });
    expect(await proxy.authorize("api.example.com:443")).toBe(true);
    expect(onUnknownDomain).not.toHaveBeenCalled();
  });

  it("getSessionAllowedHosts は once 許可した先を返す（永続 allowlist の物は除く・W1）", async () => {
    const { proxy } = mk({ allowed: ["github.com"], decision: "once" });
    await proxy.authorize("new.com"); // once
    await proxy.authorize("github.com"); // 永続 allowlist（除外される）
    expect(proxy.getSessionAllowedHosts()).toEqual(["new.com"]);
  });

  it("revoke で once 許可を取り消すと再度確認される", async () => {
    const { proxy, onUnknownDomain } = mk({ decision: "once" });
    expect(await proxy.authorize("new.com")).toBe(true);
    expect(onUnknownDomain).toHaveBeenCalledTimes(1);
    proxy.revoke("new.com"); // /sandbox deny 相当
    expect(await proxy.authorize("new.com")).toBe(true);
    expect(onUnknownDomain).toHaveBeenCalledTimes(2); // 取り消し後は再確認
  });
});
