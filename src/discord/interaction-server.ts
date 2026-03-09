/**
 * Discord Slash Command 受信サーバー
 *
 * Discord Developer Portal で設定した Interactions Endpoint URL に対して
 * Discord がリクエストを送信してくる。本モジュールはそれを受け取り AgentLoop で処理する。
 *
 * セットアップ手順:
 * 1. Discord Developer Portal でアプリを作成し applicationId, publicKey, botToken を取得
 * 2. /discord app-id / /discord public-key / /discord bot-token で設定
 * 3. /discord register でスラッシュコマンドを登録
 * 4. /discord listen start でサーバーを起動
 * 5. Discord Developer Portal の Interactions Endpoint URL を
 *    http://<your-ip>:<port>/interactions に設定
 *    (ローカル環境の場合は cloudflared tunnel や ngrok で公開)
 */

import * as http from "http";
import * as crypto from "crypto";
import type { AgentLoop } from "../agent/agent-loop.js";
import type { DiscordConfig } from "../config/types.js";
import * as logger from "../utils/logger.js";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_MAX_LENGTH = 1900; // 余裕を持たせて 1900

export class DiscordInteractionServer {
  private server: http.Server | null = null;
  private _running = false;

  constructor(
    private config: DiscordConfig,
    private agentLoop: AgentLoop,
  ) {}

  /** HTTP サーバーを起動する */
  async start(): Promise<void> {
    if (this._running) return;

    const port = this.config.interactionPort ?? 3003;

    this.server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/interactions") {
        res.writeHead(404).end("Not Found");
        return;
      }

      // ボディを読み込む
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString("utf-8");

      // Discord 署名検証
      const signature = req.headers["x-signature-ed25519"] as string | undefined;
      const timestamp = req.headers["x-signature-timestamp"] as string | undefined;

      if (!signature || !timestamp || !this.config.publicKey) {
        res.writeHead(401).end("Unauthorized");
        return;
      }

      const valid = await this.verifySignature(body, signature, timestamp);
      if (!valid) {
        res.writeHead(401).end("Invalid request signature");
        return;
      }

      let interaction: any;
      try {
        interaction = JSON.parse(body);
      } catch {
        res.writeHead(400).end("Bad Request");
        return;
      }

      // PING (type: 1) - Discord の疎通確認
      if (interaction.type === 1) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: 1 }));
        return;
      }

      // APPLICATION_COMMAND (type: 2) - スラッシュコマンド
      if (interaction.type === 2) {
        await this.handleCommand(res, interaction);
        return;
      }

      res.writeHead(400).end("Unknown interaction type");
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, () => {
        this._running = true;
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  /** HTTP サーバーを停止する */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this._running = false;
    }
  }

  get running(): boolean {
    return this._running;
  }

  /** Discord の Ed25519 署名を検証する (Node.js 18+ 組み込み crypto.subtle 使用) */
  private async verifySignature(body: string, signature: string, timestamp: string): Promise<boolean> {
    try {
      const publicKeyBytes = Buffer.from(this.config.publicKey!, "hex");
      const key = await crypto.subtle.importKey(
        "raw",
        publicKeyBytes,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const signatureBytes = Buffer.from(signature, "hex");
      const messageBytes = Buffer.from(timestamp + body, "utf-8");
      return await crypto.subtle.verify("Ed25519", key, signatureBytes, messageBytes);
    } catch (e) {
      logger.error("Discord signature verification error:", e);
      return false;
    }
  }

  /** /ask コマンドを処理する */
  private async handleCommand(res: http.ServerResponse, interaction: any): Promise<void> {
    const commandName = interaction.data?.name;
    if (commandName !== "ask") {
      res.writeHead(400).end("Unknown command");
      return;
    }

    // Discord の 3 秒ルール: まず deferred 応答を返す (type: 5)
    // その後非同期で処理して follow-up を送信する
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: 5 })); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE

    const prompt = interaction.data?.options?.[0]?.value as string ?? "";
    const token = interaction.token as string;
    const username = interaction.member?.user?.username ?? interaction.user?.username ?? "Unknown";

    console.log(`\n  [Discord] ${username}: ${prompt}`);

    // 非同期で処理 (deferred 応答済みのため時間制限なし)
    this.processPrompt(prompt, token).catch((e) => {
      logger.error("Discord prompt processing error:", e);
      this.sendFollowUp(token, "❌ 処理中にエラーが発生しました。").catch(() => {});
    });
  }

  /** AgentLoop でプロンプトを処理し、Discord に結果を返す */
  private async processPrompt(prompt: string, token: string): Promise<void> {
    if (this.agentLoop.isProcessing) {
      await this.sendFollowUp(
        token,
        "⏳ 現在別のリクエストを処理中です。少し待ってから再試行してください。",
      );
      return;
    }

    try {
      await this.agentLoop.run(prompt, { source: "discord" });

      // 最後のアシスタントメッセージを取得
      const messages = this.agentLoop.getHistory().getMessages();
      let responseText = "";

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
          if (typeof msg.content === "string") {
            responseText = msg.content;
          } else if (Array.isArray(msg.content)) {
            responseText = (msg.content as any[])
              .filter((c) => c.type === "text")
              .map((c) => c.text as string)
              .join("\n");
          }
          break;
        }
      }

      // <think>...</think> タグを除去
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

      if (!responseText) {
        responseText = "（応答なし）";
      }

      // Discord の 2000 文字制限に合わせて分割して送信
      const chunks = splitMessage(responseText, DISCORD_MAX_LENGTH);
      for (const chunk of chunks) {
        await this.sendFollowUp(token, chunk);
      }
    } catch (e) {
      logger.error("AgentLoop processing error:", e);
      throw e;
    }
  }

  /** Discord interaction の follow-up メッセージを送信する */
  private async sendFollowUp(token: string, content: string): Promise<void> {
    const appId = this.config.applicationId;
    if (!appId) {
      logger.warn("Discord applicationId not configured, cannot send follow-up");
      return;
    }

    const url = `${DISCORD_API}/webhooks/${appId}/${token}/messages/@original`;
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "lllmAgents/1.0",
        },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const text = await res.text();
        logger.error(`Discord follow-up failed: ${res.status} ${text}`);
      }
    } catch (e) {
      logger.error("Failed to send Discord follow-up:", e);
    }
  }
}

/** 長いメッセージを Discord の文字数制限に合わせて分割する */
function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxLength, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > pos + maxLength / 2) end = nl + 1;
    }
    chunks.push(text.slice(pos, end));
    pos = end;
  }
  return chunks;
}
