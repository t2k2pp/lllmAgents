import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { SandboxProxy } from "../../src/security/sandbox-proxy.js";

/**
 * プロキシ実体（http.Server）を起動し、 外部通信を伴わずに「拒否パス」を検証する統合テスト。
 * 実装者レビュー指摘「CONNECT/HTTP フォワードのハンドラにテストが0件」への対応。
 * 許可後の正常トンネルは外部到達が要るので対象外（拒否系＝接続前に弾く経路のみ）。
 */

let proxy: SandboxProxy | null = null;
afterEach(() => {
  proxy?.stop();
  proxy = null;
});

/** プロキシへ生のリクエスト行を送り、 1行目（ステータス行）を返す。 */
function sendRaw(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(payload));
    let buf = "";
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error("timeout"));
    });
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n")) {
        resolve(buf.split("\r\n")[0]);
        sock.destroy();
      }
    });
    sock.on("error", reject);
  });
}

function mkProxy(allowed: string[]): SandboxProxy {
  return new SandboxProxy({
    getAllowedDomains: () => allowed,
    onUnknownDomain: async () => "deny",
    persistDomain: () => {},
  });
}

describe("SandboxProxy 拒否パス (integration)", () => {
  it("CONNECT の 443/80 以外は 403", async () => {
    proxy = mkProxy(["example.com"]); // ドメインは許可済みでもポートで弾く
    const port = await proxy.ensureStarted();
    const line = await sendRaw(port, "CONNECT example.com:22 HTTP/1.1\r\nHost: example.com:22\r\n\r\n");
    expect(line).toContain("403");
  });

  it("HTTP フォワードの 80/443 以外は 403", async () => {
    proxy = mkProxy(["example.com"]);
    const port = await proxy.ensureStarted();
    const line = await sendRaw(port, "GET http://example.com:8080/ HTTP/1.1\r\nHost: example.com:8080\r\n\r\n");
    expect(line).toContain("403");
  });

  it("許可ドメインでも内部IP(loopback)へは SSRF 遮断で 403", async () => {
    proxy = mkProxy(["127.0.0.1"]); // authorize は通るが resolvePinnedIp で弾く
    const port = await proxy.ensureStarted();
    const line = await sendRaw(port, "GET http://127.0.0.1:80/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    expect(line).toContain("403");
  });

  it("CONNECT で内部IP(メタデータ)へは SSRF 遮断で 403", async () => {
    proxy = mkProxy(["169.254.169.254"]);
    const port = await proxy.ensureStarted();
    const line = await sendRaw(port, "CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n");
    expect(line).toContain("403");
  });

  it("未許可ドメイン(非対話 deny)は 403", async () => {
    proxy = mkProxy([]); // allowlist 空 + onUnknownDomain=deny
    const port = await proxy.ensureStarted();
    const line = await sendRaw(port, "GET http://evil.example/ HTTP/1.1\r\nHost: evil.example\r\n\r\n");
    expect(line).toContain("403");
  });
});
