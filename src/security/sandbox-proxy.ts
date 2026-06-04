/**
 * サンドボックス用の在プロセス HTTP プロキシ（Phase 2b-1）。
 * docs/wsl-sandbox-design.md §7.1。
 *
 * サンドボックス内の bash 子プロセスに HTTP(S)_PROXY として注入し、 全ネット通信を
 * このプロキシ経由に強制する（macOS は Seatbelt で localhost:port のみ許可）。
 * 未許可ドメインへの接続は onUnknownDomain で対話確認し、 許可で allowlist へ。
 *
 * Claude Code は別プロセス + socat + unix socket だが、 ここはエージェント本体の
 * プロセス内 http.Server にすることで IPC 無しに REPL 確認へ繋げている。
 * TLS は終端しない（CONNECT をホスト名で許可/拒否しトンネルするだけ）。
 */

import * as http from "node:http";
import * as net from "node:net";
import * as dns from "node:dns/promises";
import type { Socket } from "node:net";
import { domainAllowed, normalizeHost } from "./net-allowlist.js";

export type DomainDecision = "once" | "always" | "deny";

/** トンネル/上流接続のアイドルタイムアウト（ハング・FD リーク防止）。 */
const SOCKET_TIMEOUT_MS = 30_000;
/** プロキシが中継を許すポート（CONNECT/HTTP 共通）。 */
const ALLOWED_PORTS = new Set([80, 443]);

/** CONNECT ターゲット "host:port" / "[ipv6]:port" から port を取り出す（既定 443）。 */
export function parseConnectPort(target: string): number {
  const t = target.trim();
  // [ipv6]:port を優先的に処理（裸 IPv6 の末尾コロンを port と誤認しない）
  const br = /^\[[^\]]+\]:(\d+)$/.exec(t);
  if (br) return parseInt(br[1], 10);
  if (t.startsWith("[")) return 443; // [ipv6]（port 無し）
  const colons = (t.match(/:/g) ?? []).length;
  if (colons === 1) {
    const m = /:(\d+)$/.exec(t);
    if (m) return parseInt(m[1], 10);
  }
  return 443; // host 単独 / 裸 IPv6（多コロン）は既定 443
}

/** IPv4 オクテットが内部/予約レンジか（CGNAT 100.64/10 含む）。 */
function isBlockedV4(o: number[]): boolean {
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0 || a === 127) return true; // this-host / loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local + メタデータ 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** IPv6 文字列を 128bit BigInt へ（:: 展開・末尾ドット v4 対応）。 不正は null。 */
function ipv6ToBigInt(v: string): bigint | null {
  let s = v;
  let tailV4: bigint | null = null;
  const lastColon = s.lastIndexOf(":");
  if (lastColon >= 0 && s.slice(lastColon + 1).includes(".")) {
    const o = s.slice(lastColon + 1).split(".").map(Number);
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    tailV4 = (BigInt(o[0]) << 24n) | (BigInt(o[1]) << 16n) | (BigInt(o[2]) << 8n) | BigInt(o[3]);
    s = s.slice(0, lastColon + 1) + "0:0"; // 末尾2グループを 0 placeholder に（後で tailV4 を OR）
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(":").filter((x) => x !== "") : [];
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(":").filter((x) => x !== "") : [];
  let groups: string[];
  if (dbl.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let val = 0n;
  for (const g of groups) {
    const n = parseInt(g || "0", 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    val = (val << 16n) | BigInt(n);
  }
  if (tailV4 !== null) val |= tailV4; // 末尾32bit を v4 で上書き（placeholder は 0）
  return val;
}

/**
 * 接続先IPが内部/予約レンジ（loopback・link-local＝メタデータ・RFC1918・CGNAT・ULA・site-local・
 * NAT64・v4-mapped 内部）か。 プロキシが「許可ドメインに見せかけ内部サービスへ中継」する SSRF
 * 踏み台になるのを防ぐ。 展開表記(0:0:..:1)・16進 v4-mapped・10進/8進/16進 IPv4 も漏らさない。
 */
export function isBlockedAddress(ip: string): boolean {
  const v = ip.replace(/%.*$/, "").replace(/^\[|\]$/g, ""); // zone id・ブラケットを除去
  const kind = net.isIP(v);
  if (kind === 4) return isBlockedV4(v.split(".").map(Number));
  if (kind === 6) {
    const val = ipv6ToBigInt(v.toLowerCase());
    if (val === null) return true; // パース不能は安全側で遮断
    if (val === 0n || val === 1n) return true; // unspecified / loopback (展開表記も網羅)
    const h = val >> 112n; // 先頭16bit
    if ((h & 0xffc0n) === 0xfe80n) return true; // link-local fe80::/10
    if ((h & 0xfe00n) === 0xfc00n) return true; // ULA fc00::/7
    if ((h & 0xffc0n) === 0xfec0n) return true; // site-local(廃止) fec0::/10
    const top96 = val >> 32n;
    const toV4 = (): number[] => {
      const lo = Number(val & 0xffffffffn);
      return [(lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255];
    };
    if (top96 === 0xffffn) return isBlockedV4(toV4()); // ::ffff:0:0/96 v4-mapped
    if (top96 === 0x0064ff9b0000000000000000n) return isBlockedV4(toV4()); // NAT64 64:ff9b::/96
    return false;
  }
  return true; // 解決不能な値は安全側で遮断
}

/**
 * ホスト名/IP を解決し、 接続先として安全な実IPを1つ返す（内部レンジは拒否＝例外）。
 * ホスト名は解決済みIPを「ピン留め」して返すことで、 authorize 後に別IPへ向く DNS rebinding を防ぐ。
 */
async function resolvePinnedIp(host: string): Promise<string> {
  const h = host.replace(/^\[|\]$/g, ""); // IPv6 リテラルのブラケットを除去
  if (net.isIP(h)) {
    if (isBlockedAddress(h)) throw new Error(`blocked internal address: ${h}`);
    return h;
  }
  const { address } = await dns.lookup(h); // 先頭の解決結果を採用
  if (isBlockedAddress(address)) throw new Error(`host resolves to internal address: ${h} -> ${address}`);
  return address;
}

/** プロキシ転送時に除去すべき hop-by-hop ヘッダ（RFC 7230 §6.1 + プロキシ固有）。 */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
function stripHopByHop(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const out: http.IncomingHttpHeaders = { ...headers };
  for (const k of HOP_BY_HOP_HEADERS) delete out[k];
  return out;
}

/** トンネル確立前の上流エラー時にクライアントへ 502 を返して閉じる。 */
function reject502(sock: Socket): void {
  try {
    sock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    sock.end();
  } catch {
    /* ignore */
  }
}

export interface SandboxProxyDeps {
  /** 永続 allowlist（config 由来。 既定リストを含めた最終形を返す） */
  getAllowedDomains(): string[];
  /** 未許可ドメインへの初回アクセス時にユーザーへ確認する */
  onUnknownDomain(host: string): Promise<DomainDecision>;
  /** "always" 選択時に永続 allowlist へ保存する */
  persistDomain(domain: string): void;
}

export class SandboxProxy {
  private server: http.Server | null = null;
  private port = 0;
  private starting: Promise<number> | null = null;
  /** "once" で当該セッション中だけ許可されたドメイン */
  private sessionAllowed = new Set<string>();
  /** 同一ホストの確認が並行多発しないよう進行中の確認を集約 */
  private pending = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: SandboxProxyDeps) {}

  getPort(): number {
    return this.port;
  }
  isRunning(): boolean {
    return this.server !== null;
  }

  /** プロキシを起動して listen ポートを返す（冪等）。 */
  async ensureStarted(): Promise<number> {
    if (this.server) return this.port;
    if (this.starting) return this.starting;
    this.starting = new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.on("connect", (req, socket, head) => this.handleConnect(req, socket as Socket, head));
      server.on("clientError", (_e, socket) => {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      });
      server.on("error", (e) => {
        this.starting = null;
        reject(e);
      });
      // 127.0.0.1 のみ（外部からは触れない）
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        this.port = addr && typeof addr === "object" ? addr.port : 0;
        this.server = server;
        resolve(this.port);
      });
    });
    return this.starting;
  }

  stop(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* ignore */
      }
      this.server = null;
      this.port = 0;
      this.starting = null;
    }
  }

  /** host が現時点で許可済みか（セッション once + 永続 allowlist） */
  isAllowed(host: string): boolean {
    const h = normalizeHost(host);
    if (this.sessionAllowed.has(h)) return true;
    return domainAllowed(h, this.deps.getAllowedDomains());
  }

  /** 許可判定（未許可なら確認）。 同一ホストの並行確認は1回に集約。 */
  async authorize(host: string): Promise<boolean> {
    const h = normalizeHost(host);
    if (!h) return false;
    if (this.isAllowed(h)) return true;

    const inflight = this.pending.get(h);
    if (inflight) return inflight;

    const p = (async (): Promise<boolean> => {
      const decision = await this.deps.onUnknownDomain(h);
      if (decision === "deny") return false;
      if (decision === "always") this.deps.persistDomain(h);
      this.sessionAllowed.add(h); // once / always とも当該セッションは許可
      return true;
    })().finally(() => this.pending.delete(h));

    this.pending.set(h, p);
    return p;
  }

  /** セッション once 許可を取り消す（`/sandbox deny` 時に呼ぶ。 永続 allowlist 側は config で別途除去）。 */
  revoke(host: string): void {
    this.sessionAllowed.delete(normalizeHost(host));
  }

  // ── ハンドラ ──────────────────────────────────────────────────────────────

  /** 両ソケットを相互に確実に閉じ、 アイドルタイムアウトを張る（FD リーク・ハング防止）。 */
  private wireTunnel(a: Socket, b: Socket): void {
    const closeBoth = () => {
      a.destroy();
      b.destroy();
    };
    for (const s of [a, b]) {
      s.setTimeout(SOCKET_TIMEOUT_MS, closeBoth);
      s.on("error", closeBoth);
      s.on("close", () => {
        // 片側が閉じたら相手も閉じる（半開き放置を防ぐ）
        if (!b.destroyed) b.destroy();
        if (!a.destroyed) a.destroy();
      });
    }
  }

  /** HTTPS の CONNECT: ホスト名で許可判定し、 許可ならトンネル（TLS は素通し） */
  private handleConnect(req: http.IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const target = req.url ?? ""; // "host:port"
    const host = normalizeHost(target);
    const port = parseConnectPort(target);
    const reject = () => {
      try {
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.end();
      } catch {
        /* ignore */
      }
    };

    // 許可ポートは 443/80 のみ（許可ドメインの任意ポートへのトンネル悪用を防ぐ）
    if (!ALLOWED_PORTS.has(port)) {
      reject();
      return;
    }

    this.authorize(host)
      .then(async (ok) => {
        if (!ok) {
          reject();
          return;
        }
        // 内部レンジ遮断＋IPピン留め（authorize 後の DNS rebinding を防ぐ）
        const ip = await resolvePinnedIp(host);
        let established = false;
        const upstream = net.connect(port, ip, () => {
          established = true;
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head && head.length) upstream.write(head);
          this.wireTunnel(clientSocket, upstream); // 確立後の相互クローズ・アイドルTO
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.setTimeout(SOCKET_TIMEOUT_MS, () => upstream.destroy()); // 接続前ハング防止
        upstream.on("error", () => {
          if (!established) reject502(clientSocket); // 確立後は wireTunnel が処理
        });
        clientSocket.on("error", () => {
          if (!established) upstream.destroy();
        });
      })
      .catch(() => {
        // 認可拒否でないエラー（内部IP・解決失敗等）はトンネル前なので 403 で塞ぐ
        reject();
      });
  }

  /** プレーン HTTP のフォワード */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 認可対象と実接続先を必ず同一の url.hostname に統一する
    // （Host ヘッダとリクエストラインのドメイン不一致による allowlist 迂回を防ぐ）。
    let url: URL;
    try {
      url = new URL(
        (req.url ?? "").startsWith("http") ? req.url! : `http://${req.headers.host ?? ""}${req.url ?? ""}`,
      );
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // ポートは 80/443 のみ（CONNECT と同じ制限。 許可ドメインの任意ポートへの平文中継を防ぐ）。
    const reqPort = url.port ? parseInt(url.port, 10) : 80;
    if (!ALLOWED_PORTS.has(reqPort)) {
      res.writeHead(403);
      res.end("blocked by sandbox (port not allowed)");
      return;
    }
    this.authorize(url.hostname)
      .then(async (ok) => {
        if (!ok) {
          res.writeHead(403);
          res.end("blocked by sandbox allowlist");
          return;
        }
        // 内部レンジ遮断＋IPピン留め（SSRF・DNS rebinding 防止）
        const ip = await resolvePinnedIp(url.hostname);
        const proxyReq = http.request(
          {
            host: ip,
            port: reqPort,
            path: url.pathname + url.search,
            method: req.method,
            // Host は元のホスト名を維持（vhost 正配送）。 接続先IPはピン留め済み。
            // hop-by-hop ヘッダ（Proxy-Authorization 等）は上流へ漏らさない。
            headers: { ...stripHopByHop(req.headers), host: url.host },
            timeout: SOCKET_TIMEOUT_MS,
          },
          (pr) => {
            res.writeHead(pr.statusCode ?? 502, pr.headers);
            pr.pipe(res);
          },
        );
        proxyReq.on("timeout", () => proxyReq.destroy());
        proxyReq.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(proxyReq);
      })
      .catch(() => {
        // 認可拒否でないエラー（内部IP・解決失敗）は 403
        if (!res.headersSent) {
          res.writeHead(403);
          res.end("blocked by sandbox (resolve/internal)");
        } else {
          res.end();
        }
      });
  }
}

// ── シングルトン（bash ツールと REPL で共有） ────────────────────────────────

let instance: SandboxProxy | null = null;

/** プロキシを deps 付きで構成する（起動時に REPL から呼ぶ）。 */
export function configureSandboxProxy(deps: SandboxProxyDeps): SandboxProxy {
  instance = new SandboxProxy(deps);
  return instance;
}

/** 構成済みプロキシを返す（未構成なら null＝プロキシ強制しない）。 */
export function getSandboxProxy(): SandboxProxy | null {
  return instance;
}

/** テスト用リセット。 */
export function resetSandboxProxy(): void {
  if (instance) instance.stop();
  instance = null;
}
