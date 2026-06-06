import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import * as http from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

/** ループバック上流をテストするための寛容プロキシ（内部IP遮断とポート制限を無効化）。 */
function mkPermissiveProxy(allowed: string[], upstreamPort: number): SandboxProxy {
  return new SandboxProxy({
    getAllowedDomains: () => allowed,
    onUnknownDomain: async () => "deny",
    persistDomain: () => {},
    isAddressBlocked: () => false, // 127.0.0.1 上流を許可（テスト専用シーム）
    allowedPorts: new Set([upstreamPort, 80, 443]),
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

  it("許可ドメインでも内部IP(loopback)へは SSRF 遮断で 403、 中継記録にも残らない", async () => {
    proxy = mkProxy(["127.0.0.1"]); // authorize は通るが resolvePinnedIp で弾く
    const port = await proxy.ensureStarted();
    const line = await sendRaw(port, "GET http://127.0.0.1:80/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    expect(line).toContain("403");
    // 遮断された接続は「中継した宛先」に記録しない（B-3 監査の正確性）
    expect(proxy.getRelayedHosts()).toEqual([]);
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

  it("許可済み HTTP は上流へ転送され body が往復する（成功トンネル・転送）", async () => {
    // ダミー上流（ローカル http.Server）
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("HELLO-FROM-UPSTREAM");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const upPort = (upstream.address() as net.AddressInfo).port;
    try {
      proxy = mkPermissiveProxy(["127.0.0.1"], upPort);
      const port = await proxy.ensureStarted();
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: `http://127.0.0.1:${upPort}/`, headers: { host: `127.0.0.1:${upPort}` } },
          (res) => {
            let b = "";
            res.on("data", (d) => (b += d));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(200);
      expect(body).toBe("HELLO-FROM-UPSTREAM");
      expect(proxy.getRelayedHosts()).toContain("127.0.0.1"); // 監査に記録される
    } finally {
      upstream.close();
    }
  });

  it("許可済み CONNECT はトンネルが確立し双方向にバイトが流れる（成功トンネル・CONNECT）", async () => {
    // ダミー上流（生 TCP エコー）
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    const upPort = (echo.address() as net.AddressInfo).port;
    try {
      proxy = mkPermissiveProxy(["127.0.0.1"], upPort);
      const port = await proxy.ensureStarted();
      const echoed = await new Promise<string>((resolve, reject) => {
        const req = http.request({ method: "CONNECT", host: "127.0.0.1", port, path: `127.0.0.1:${upPort}` });
        req.on("connect", (_res, socket) => {
          socket.write("PING");
          let buf = "";
          socket.on("data", (d) => {
            buf += d.toString();
            if (buf.length >= 4) {
              resolve(buf);
              socket.destroy();
            }
          });
          socket.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      });
      expect(echoed).toBe("PING"); // トンネル経由で上流エコーが返る
    } finally {
      echo.close();
    }
  });

  it("unix ソケット listen でも同じ allowlist 判定が効く (Linux ブリッジ土台)", async () => {
    proxy = mkProxy([]); // 全未許可・deny
    const sock = join(tmpdir(), `lllm-proxy-test-${process.pid}.sock`);
    await proxy.ensureUnixSocket(sock);
    // unix ソケット経由で forward proxy リクエスト（未許可→403）
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { socketPath: sock, path: "http://evil.example/", method: "GET", headers: { host: "evil.example" } },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});
