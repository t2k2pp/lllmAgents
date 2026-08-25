import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { requestPublicText } from "../../src/security/public-http.js";
import { resolvePinnedIp } from "../../src/security/sandbox-proxy.js";

const servers: http.Server[] = [];

async function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("public HTTP boundary", () => {
  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.1",
    "::1",
    "fc00::1",
  ])("内部・予約アドレス %s を拒否する", async (host) => {
    await expect(resolvePinnedIp(host)).rejects.toThrow(/blocked internal address/);
  });

  it("解決結果にprivate IPが一つでも混ざれば拒否する", async () => {
    const lookup = (async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]) as never;
    await expect(resolvePinnedIp("mixed.example", undefined, lookup)).rejects.toThrow(/resolves to internal/);
  });

  it("解決済みIPへpinして公開ホストの応答を取得する", async () => {
    const port = await startServer((_req, res) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("ok");
    });
    const res = await requestPublicText(`http://public.example:${port}/hello`, {
      resolveHost: async (host) => {
        expect(host).toBe("public.example");
        return "127.0.0.1";
      },
    });
    expect(res.body).toBe("ok");
  });

  it("redirect先も再検証してlocalhostへの遷移を拒否する", async () => {
    const port = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://localhost/private");
      res.end();
    });
    await expect(
      requestPublicText(`http://public.example:${port}/`, {
        resolveHost: async (host) => {
          if (host === "public.example") return "127.0.0.1";
          return await resolvePinnedIp(host);
        },
      }),
    ).rejects.toThrow(/internal address/);
  });
});
