import { describe, it, expect, vi } from "vitest";
import { SandboxProxy, type DomainDecision } from "../../src/security/sandbox-proxy.js";

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
});
