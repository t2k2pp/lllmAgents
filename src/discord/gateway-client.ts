/**
 * Discord Gateway v10 最小クライアント
 *
 * Bot がこちらから Discord に WebSocket で接続し、INTERACTION_CREATE を受け取る。
 * 公開 URL・ポート開放・トンネルは不要 (Slack Socket Mode と同じ外向き接続モデル)。
 * 設計: docs/discord-gateway-design.md
 *
 * 本クライアントが扱うのは「接続を維持して interaction を受け取る」ことだけ。
 * interaction への応答 (callback / follow-up) は呼び出し側 (interaction-server.ts) が
 * REST API で行う。
 *
 * 依存: undici の WebSocket (既存の直接依存。新規パッケージ追加なし)
 */

import { WebSocket } from "undici";
import * as logger from "../utils/logger.js";

const DISCORD_API = "https://discord.com/api/v10";

/** Gateway opcodes (https://discord.com/developers/docs/topics/opcodes-and-status-codes) */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** 再接続しても回復しない close code → 原因を表示して停止する */
const FATAL_CLOSE_CODES: Record<number, string> = {
  4004: "Bot Token が正しくありません。/integrations の Discord 連携メニューから設定し直してください。",
  4010: "シャード設定が不正です (本ツールでは通常発生しません)。",
  4011: "サーバー数が多くシャーディングが必要です。",
  4012: "Gateway API バージョンが無効です (アプリの更新が必要かもしれません)。",
  4013: "Gateway intents の値が不正です。",
  4014: "許可されていない Gateway intents が指定されています。",
};

const MAX_BACKOFF_MS = 60_000;

export interface GatewayClientOptions {
  botToken: string;
  /** INTERACTION_CREATE 受信時に呼ばれる */
  onInteraction: (interaction: any) => void;
  /** 接続確立 (READY / RESUMED) ・切断などの状態変化通知 (CLI 表示用) */
  onStatus?: (message: string) => void;
}

export class DiscordGatewayClient {
  private ws: WebSocket | null = null;
  private stopped = true;

  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUsername: string | null = null;

  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAcked = true;
  private reconnectAttempts = 0;
  private connected = false;

  constructor(private options: GatewayClientOptions) {}

  /** 接続中 (READY / RESUMED 済み) かどうか */
  get running(): boolean {
    return this.connected;
  }

  /** 接続済み Bot のユーザー名 (READY 後に取得可能) */
  get botUser(): string | null {
    return this.botUsername;
  }

  /**
   * Gateway に接続する。READY を受信するまで待つ。
   * 接続後の切断は自動で再接続し、回復不能なエラーは onStatus で通知して停止する。
   */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAttempts = 0;
    try {
      await this.connect(false);
    } catch (e) {
      // 初回接続の失敗は自動リトライせず呼び出し元へ (設定ミスをすぐ気付けるように)
      this.stop();
      throw e;
    }
  }

  /** 切断する (再接続しない) */
  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
  }

  // ─── 接続処理 ───

  /** 接続先 URL を決めて WS を張る。resume=true なら前回セッションの再開を試みる */
  private async connect(resume: boolean): Promise<void> {
    const url = resume && this.resumeGatewayUrl ? this.resumeGatewayUrl : await this.fetchGatewayUrl();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(`${url}/?v=10&encoding=json`);
      this.ws = ws;

      ws.addEventListener("message", (ev) => {
        let payload: any;
        try {
          payload = JSON.parse(String(ev.data));
        } catch (e) {
          logger.error("Discord Gateway: invalid JSON frame:", e);
          return;
        }
        this.handlePayload(payload, resume, () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });

      ws.addEventListener("close", (ev) => {
        // closeAndReconnect / stop が張り替え済みの古いソケット → 再接続は別経路が担う
        if (this.ws !== ws) return;
        this.clearHeartbeat();
        this.connected = false;
        if (this.stopped) return;

        const fatal = FATAL_CLOSE_CODES[ev.code];
        if (fatal) {
          this.stopped = true;
          const msg = `Discord Bot 接続を停止しました (code ${ev.code}): ${fatal}`;
          logger.error(msg);
          this.options.onStatus?.(msg);
          if (!settled) {
            settled = true;
            reject(new Error(msg));
          }
          return;
        }

        const canResume = ev.code !== 4007 && ev.code !== 4009;
        if (settled) {
          // 確立済みの接続が切れた → 自動再接続 (4000系の多くと異常切断は Resume 可能)
          this.scheduleReconnect(canResume, `切断されました (code ${ev.code})`);
        } else {
          // 接続試行中の失敗 → 呼び出し元 (start / scheduleReconnect の catch) に委ねる
          settled = true;
          reject(new Error(`Discord Gateway への接続に失敗しました (code ${ev.code})`));
        }
      });

      ws.addEventListener("error", () => {
        // close イベントが続けて発火するため、ここでは何もしない (二重処理防止)
      });
    });
  }

  /** GET /gateway/bot で接続先 URL を取得する */
  private async fetchGatewayUrl(): Promise<string> {
    const res = await fetch(`${DISCORD_API}/gateway/bot`, {
      headers: {
        Authorization: `Bot ${this.options.botToken}`,
        "User-Agent": "lllmAgents/1.0",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new Error(
          "Bot Token が正しくありません (401)。/integrations の Discord 連携メニューから設定し直してください。",
        );
      }
      throw new Error(`Discord Gateway URL の取得に失敗しました: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { url: string };
    return data.url;
  }

  /** 受信ペイロードの振り分け */
  private handlePayload(payload: any, resume: boolean, onReady: () => void): void {
    if (typeof payload.s === "number") this.seq = payload.s;

    switch (payload.op) {
      case OP.HELLO: {
        const interval = payload.d.heartbeat_interval as number;
        this.startHeartbeat(interval);
        if (resume && this.sessionId) {
          this.send({
            op: OP.RESUME,
            d: { token: this.options.botToken, session_id: this.sessionId, seq: this.seq },
          });
        } else {
          this.send({
            op: OP.IDENTIFY,
            d: {
              token: this.options.botToken,
              // interaction の受信に intent は不要 (0 で全 interaction が届く)
              intents: 0,
              properties: { os: process.platform, browser: "lllmAgents", device: "lllmAgents" },
            },
          });
        }
        break;
      }

      case OP.DISPATCH: {
        if (payload.t === "READY") {
          this.sessionId = payload.d.session_id;
          this.resumeGatewayUrl = payload.d.resume_gateway_url;
          this.botUsername = payload.d.user?.username ?? null;
          this.connected = true;
          this.reconnectAttempts = 0;
          onReady();
        } else if (payload.t === "RESUMED") {
          this.connected = true;
          this.reconnectAttempts = 0;
          this.options.onStatus?.("Discord Bot 接続を再開しました。");
          onReady();
        } else if (payload.t === "INTERACTION_CREATE") {
          try {
            this.options.onInteraction(payload.d);
          } catch (e) {
            logger.error("Discord interaction handler error:", e);
          }
        }
        break;
      }

      case OP.HEARTBEAT:
        // Discord からの即時 heartbeat 要求
        this.send({ op: OP.HEARTBEAT, d: this.seq });
        break;

      case OP.HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;

      case OP.RECONNECT:
        // Discord 側からの再接続指示 (Resume 可能)
        this.closeAndReconnect(true, "Discord から再接続指示を受けました");
        break;

      case OP.INVALID_SESSION: {
        const resumable = payload.d === true;
        // resumable=false の場合は 1〜5 秒待ってから Identify し直す (Discord の推奨)
        const wait = resumable ? 0 : 1000 + Math.random() * 4000;
        setTimeout(() => this.closeAndReconnect(resumable, "セッションが無効になりました"), wait);
        break;
      }
    }
  }

  // ─── heartbeat ───

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatAcked = true;
    // 初回は interval * jitter 後 (Discord の仕様。全クライアント同時送信を避ける)
    const schedule = (delay: number) => {
      this.heartbeatTimer = setTimeout(() => {
        if (!this.heartbeatAcked) {
          // 前回の ACK が返ってこない = ゾンビ接続 → 張り直して Resume
          this.closeAndReconnect(true, "応答のない接続を検出しました (heartbeat ACK 欠落)");
          return;
        }
        this.heartbeatAcked = false;
        this.send({ op: OP.HEARTBEAT, d: this.seq });
        schedule(intervalMs);
      }, delay);
    };
    schedule(intervalMs * Math.random());
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── 再接続 ───

  /** 現在の WS を閉じて再接続をスケジュールする */
  private closeAndReconnect(canResume: boolean, reason: string): void {
    if (this.stopped) return;
    this.clearHeartbeat();
    this.connected = false;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        // 1000/1001 以外で閉じると Discord はセッションを失効させないため Resume できる
        ws.close(4900 as any);
      } catch {
        /* already closed */
      }
    }
    this.scheduleReconnect(canResume, reason);
  }

  private scheduleReconnect(canResume: boolean, reason: string): void {
    if (this.stopped) return;
    const backoff = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_BACKOFF_MS);
    this.reconnectAttempts++;
    logger.warn(`Discord Gateway: ${reason}。${Math.round(backoff / 1000)} 秒後に再接続します...`);
    setTimeout(() => {
      if (this.stopped) return;
      this.connect(canResume).catch((e) => {
        // connect 内の close ハンドラが次の再接続をスケジュールする。
        // ここに来るのは fetchGatewayUrl 失敗など接続前のエラー
        if (this.stopped) return;
        logger.error(`Discord Gateway 再接続失敗: ${e}`);
        this.scheduleReconnect(canResume, "再接続に失敗しました");
      });
    }, backoff);
  }

  private send(payload: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch (e) {
      logger.error("Discord Gateway send error:", e);
    }
  }
}
