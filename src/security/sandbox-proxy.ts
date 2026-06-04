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
import type { Socket } from "node:net";
import { domainAllowed, normalizeHost } from "./net-allowlist.js";

export type DomainDecision = "once" | "always" | "deny";

/** CONNECT ターゲット "host:port" / "[ipv6]:port" から port を取り出す（既定 443）。 */
export function parseConnectPort(target: string): number {
  const m = /:(\d+)$/.exec(target.trim());
  return m ? parseInt(m[1], 10) : 443;
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

  // ── ハンドラ ──────────────────────────────────────────────────────────────

  /** HTTPS の CONNECT: ホスト名で許可判定し、 許可ならトンネル（TLS は素通し） */
  private handleConnect(req: http.IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const target = req.url ?? ""; // "host:port"
    const host = normalizeHost(target);
    const port = parseConnectPort(target);

    // 許可ポートは 443/80 のみ（許可ドメインの任意ポートへのトンネル悪用を防ぐ）
    if (port !== 443 && port !== 80) {
      try {
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.end();
      } catch {
        /* ignore */
      }
      return;
    }

    this.authorize(host)
      .then((ok) => {
        if (!ok) {
          try {
            clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            clientSocket.end();
          } catch {
            /* ignore */
          }
          return;
        }
        const upstream = net.connect(port, host, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head && head.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", () => {
          try {
            clientSocket.end();
          } catch {
            /* ignore */
          }
        });
        clientSocket.on("error", () => {
          try {
            upstream.destroy();
          } catch {
            /* ignore */
          }
        });
      })
      .catch(() => {
        try {
          clientSocket.destroy();
        } catch {
          /* ignore */
        }
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
    this.authorize(url.hostname)
      .then((ok) => {
        if (!ok) {
          res.writeHead(403);
          res.end("blocked by sandbox allowlist");
          return;
        }
        const proxyReq = http.request(
          {
            host: url.hostname,
            port: url.port || 80,
            path: url.pathname + url.search,
            method: req.method,
            headers: req.headers,
          },
          (pr) => {
            res.writeHead(pr.statusCode ?? 502, pr.headers);
            pr.pipe(res);
          },
        );
        proxyReq.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(proxyReq);
      })
      .catch(() => {
        try {
          res.destroy();
        } catch {
          /* ignore */
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
