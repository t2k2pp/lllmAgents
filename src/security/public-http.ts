import * as http from "node:http";
import * as https from "node:https";
import { resolvePinnedIp } from "./sandbox-proxy.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

export interface PublicHttpResponse {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  finalUrl: string;
}

export interface PublicHttpOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** テスト用。通常はSSRF防止のためresolvePinnedIpを使う。 */
  resolveHost?: (host: string) => Promise<string>;
}

function parsePublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http:// or https://");
  }
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  return url;
}

/**
 * 公開HTTP(S)だけを取得する。DNS解決したIPへ直接接続してpinし、redirectごとに再検証するため、
 * localhost/private/link-local とDNS rebindingの双方をweb_fetchから遮断できる。
 */
export async function requestPublicText(rawUrl: string, options: PublicHttpOptions = {}): Promise<PublicHttpResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const resolveHost = options.resolveHost ?? resolvePinnedIp;

  const visit = async (target: string, redirectsLeft: number): Promise<PublicHttpResponse> => {
    const url = parsePublicUrl(target);
    const pinnedIp = await resolveHost(url.hostname);
    const client = url.protocol === "https:" ? https : http;

    return await new Promise<PublicHttpResponse>((resolve, reject) => {
      const requestOptions: https.RequestOptions = {
        protocol: url.protocol,
        hostname: pinnedIp,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: url.hostname,
        headers: {
          Host: url.host,
          "User-Agent": "LocalLLM-Agent/0.1 (CLI Agent)",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json",
          ...options.headers,
        },
      };
      const req = client.request(requestOptions, (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`too many redirects (limit: ${maxRedirects})`));
            return;
          }
          const next = new URL(location, url).href;
          visit(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy(new Error(`response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status,
            statusText: res.statusMessage ?? "",
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
            finalUrl: url.href,
          });
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
      req.on("error", reject);
      req.end();
    });
  };

  return await visit(rawUrl, maxRedirects);
}
