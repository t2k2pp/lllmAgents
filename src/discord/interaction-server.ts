/**
 * Discord Slash Command 受信サーバー
 *
 * Discord Developer Portal で設定した Interactions Endpoint URL に対して
 * Discord がリクエストを送信してくる。本モジュールはそれを受け取り AgentLoop で処理する。
 *
 * A-2/A-3 (docs/channel-interaction-bridge-design.md): InteractionBridge を実装し、
 * 権限確認 (Message Components ボタン) と ask_user (ボタン / Modal 自由入力) を
 * Discord 上で行う。ボタン押下・Modal 送信も同じ Interactions Endpoint に届く。
 *
 * セットアップ手順:
 * 1. Discord Developer Portal でアプリを作成し applicationId, publicKey, botToken を取得
 * 2. /discord app-id / /discord public-key / /discord bot-token で設定
 * 3. /discord register でスラッシュコマンドを登録
 * 4. /discord listen start でサーバーを起動
 * 5. Discord Developer Portal の Interactions Endpoint URL を
 *    http://<your-ip>:<port>/interactions に設定
 *    (ローカル環境の場合は cloudflared tunnel や ngrok で公開)
 * 6. /discord user-add <DiscordユーザーID> (任意: 利用者を制限する場合)
 *
 * 既知の制約: interaction token は 15 分で失効するため、 15 分を超える長時間タスクの
 * 途中では権限確認・follow-up を送信できない (docs/channel-interaction-bridge-design.md §9)。
 */

import * as http from "http";
import * as crypto from "crypto";
import type { AgentLoop } from "../agent/agent-loop.js";
import type {
  TaskOutcome,
  InteractionBridge,
  PermissionRequest,
  PermissionDecision,
  AskUserRequest,
  AskUserResponse,
} from "../agent/agent-events.js";
import { setInteractionBridge } from "../agent/interaction-bridge-registry.js";
import { formatReportFooter } from "../agent/task-reporter.js";
import type { DiscordConfig } from "../config/types.js";
import * as logger from "../utils/logger.js";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_MAX_LENGTH = 1900; // 余裕を持たせて 1900
/** ask_user の「自由入力」ボタン → Modal の内部値 */
const MODAL_VALUE = "__modal__";
/** 権限確認のデフォルトタイムアウト (秒)。 ask_user はこの 2 倍 */
const DEFAULT_TIMEOUT_SEC = 300;

/** 現在処理中の会話コンテキスト。 isProcessing で直列のため 1 つで足りる (A-5 で分離予定) */
interface ConversationContext {
  /** /ask interaction の token (follow-up 送信に使用、 15 分で失効) */
  token: string;
  /** 依頼者の Discord ユーザー ID */
  userId: string;
}

interface PendingComponent {
  requesterId: string;
  kind: "permission" | "ask";
  /** ask の選択肢ラベル (custom_id "c<idx>" の解決用) */
  choices?: string[];
  resolve: (value: string) => void;
}

export class DiscordInteractionServer implements InteractionBridge {
  private server: http.Server | null = null;
  private _running = false;
  private current: ConversationContext | null = null;
  /** ボタン押下 / Modal 送信待ち: nonce → resolver */
  private pendingComponents = new Map<string, PendingComponent>();

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
        respondJson(res, { type: 1 });
        return;
      }

      // APPLICATION_COMMAND (type: 2) - スラッシュコマンド
      if (interaction.type === 2) {
        await this.handleCommand(res, interaction);
        return;
      }

      // MESSAGE_COMPONENT (type: 3) - ボタン押下 (A-2/A-3)
      if (interaction.type === 3) {
        this.handleComponent(res, interaction);
        return;
      }

      // MODAL_SUBMIT (type: 5) - 自由入力 Modal の送信 (A-3)
      if (interaction.type === 5) {
        this.handleModalSubmit(res, interaction);
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

    // A-2/A-3: 対話ブリッジとして登録 (PermissionManager / ask_user が参照)
    setInteractionBridge("discord", this);
  }

  /** HTTP サーバーを停止する */
  stop(): void {
    if (this.server) {
      setInteractionBridge("discord", null);
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

  // ─── 認可 (docs/channel-interaction-bridge-design.md §6) ───

  private isUserAllowed(userId: string): boolean {
    const allow = this.config.allowedUserIds;
    if (!allow || allow.length === 0) return true;
    return allow.includes(userId);
  }

  private static extractUserId(interaction: any): string {
    return (interaction.member?.user?.id ?? interaction.user?.id ?? "") as string;
  }

  // ─── スラッシュコマンド ───

  /** /ask コマンドを処理する */
  private async handleCommand(res: http.ServerResponse, interaction: any): Promise<void> {
    const commandName = interaction.data?.name;
    if (commandName !== "ask") {
      res.writeHead(400).end("Unknown command");
      return;
    }

    const userId = DiscordInteractionServer.extractUserId(interaction);
    if (!this.isUserAllowed(userId)) {
      // flags 64 = ephemeral (本人にのみ見える)
      respondJson(res, {
        type: 4,
        data: { content: "⛔ このボットの利用は許可されていません（allowedUserIds 設定）。", flags: 64 },
      });
      return;
    }

    // Discord の 3 秒ルール: まず deferred 応答を返す (type: 5)
    // その後非同期で処理して follow-up を送信する
    respondJson(res, { type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE

    const prompt = interaction.data?.options?.[0]?.value as string ?? "";
    const token = interaction.token as string;
    const username = interaction.member?.user?.username ?? interaction.user?.username ?? "Unknown";

    console.log(`\n  [Discord] ${username}: ${prompt}`);

    // 非同期で処理 (deferred 応答済みのため時間制限なし)
    this.processPrompt(prompt, token, userId).catch((e) => {
      logger.error("Discord prompt processing error:", e);
      this.sendFollowUp(token, "❌ 処理中にエラーが発生しました。").catch(() => {});
    });
  }

  /** AgentLoop でプロンプトを処理し、Discord に結果を返す */
  private async processPrompt(prompt: string, token: string, userId: string): Promise<void> {
    if (this.agentLoop.isProcessing) {
      await this.sendFollowUp(
        token,
        "⏳ 現在別のリクエストを処理中です。少し待ってから再試行してください。",
      );
      return;
    }

    // AgentEventBus 購読で最終応答を受け取る (docs/agent-events-design.md §3.2)
    let completeEvent: import("../agent/agent-events.js").AgentEventMap["task_complete"] | null = null;
    const off = this.agentLoop.events.on("task_complete", (e) => {
      completeEvent = e;
    });
    this.current = { token, userId };
    try {
      await this.agentLoop.run(prompt, { source: "discord" });

      const e = completeEvent as import("../agent/agent-events.js").AgentEventMap["task_complete"] | null;
      const finalResponse = e?.finalResponse ?? "";
      const outcome: TaskOutcome = e?.outcome ?? "incomplete";
      let responseText = finalResponse.trim() || outcomeFallbackText(outcome);
      // A-6: ツールを使ったタスクには構造化フッターを付ける
      const footer = e ? formatReportFooter(e) : null;
      if (footer) responseText += `\n${footer}`;

      // Discord の 2000 文字制限に合わせて分割して送信
      const chunks = splitMessage(responseText, DISCORD_MAX_LENGTH);
      for (const chunk of chunks) {
        await this.sendFollowUp(token, chunk);
      }
    } catch (e) {
      logger.error("AgentLoop processing error:", e);
      throw e;
    } finally {
      off();
      this.current = null;
    }
  }

  // ─── コンポーネント (ボタン) / Modal ───

  /** ボタン押下 (custom_id: "lllm:<nonce>:<value>") */
  private handleComponent(res: http.ServerResponse, interaction: any): void {
    const customId = (interaction.data?.custom_id as string) ?? "";
    if (!customId.startsWith("lllm:")) {
      res.writeHead(400).end("Unknown component");
      return;
    }
    const rest = customId.slice("lllm:".length);
    const sep = rest.indexOf(":");
    const nonce = sep >= 0 ? rest.slice(0, sep) : rest;
    const value = sep >= 0 ? rest.slice(sep + 1) : "";

    const pending = this.pendingComponents.get(nonce);
    if (!pending) {
      respondJson(res, {
        type: 4,
        data: { content: "（この確認は期限切れです）", flags: 64 },
      });
      return;
    }

    const clickerId = DiscordInteractionServer.extractUserId(interaction);
    if (clickerId !== pending.requesterId) {
      respondJson(res, {
        type: 4,
        data: { content: "⛔ この確認は依頼者のみ操作できます。", flags: 64 },
      });
      return;
    }

    // 自由入力: Modal を開く (pending は維持し、 Modal 送信で解決する)
    if (value === MODAL_VALUE) {
      respondJson(res, {
        type: 9, // MODAL
        data: {
          custom_id: `lllmmodal:${nonce}`,
          title: "回答を入力",
          components: [
            {
              type: 1, // ACTION_ROW
              components: [
                {
                  type: 4, // TEXT_INPUT
                  custom_id: "answer",
                  label: "回答",
                  style: 2, // PARAGRAPH
                  required: true,
                },
              ],
            },
          ],
        },
      });
      return;
    }

    this.pendingComponents.delete(nonce);

    let resolved: string;
    let display: string;
    if (pending.kind === "permission") {
      resolved = value;
      display = value === "allow_once"
        ? "✅ 許可 (今回のみ)"
        : value === "allow_session"
          ? "✅ 許可 (セッション中)"
          : "⛔ 拒否";
    } else {
      const idx = parseInt(value.slice(1), 10);
      resolved = pending.choices?.[idx] ?? value;
      display = `✅ ${resolved}`;
    }

    pending.resolve(resolved);
    // 元メッセージを更新してボタンを除去 (後からのクリック防止)
    const original = (interaction.message?.content as string) ?? "確認";
    respondJson(res, {
      type: 7, // UPDATE_MESSAGE
      data: { content: `${original}\n→ ${display}`, components: [] },
    });
  }

  /** Modal 送信 (custom_id: "lllmmodal:<nonce>") */
  private handleModalSubmit(res: http.ServerResponse, interaction: any): void {
    const customId = (interaction.data?.custom_id as string) ?? "";
    if (!customId.startsWith("lllmmodal:")) {
      res.writeHead(400).end("Unknown modal");
      return;
    }
    const nonce = customId.slice("lllmmodal:".length);
    const pending = this.pendingComponents.get(nonce);
    if (!pending) {
      respondJson(res, {
        type: 4,
        data: { content: "（この確認は期限切れです）", flags: 64 },
      });
      return;
    }

    const submitterId = DiscordInteractionServer.extractUserId(interaction);
    if (submitterId !== pending.requesterId) {
      respondJson(res, {
        type: 4,
        data: { content: "⛔ この確認は依頼者のみ操作できます。", flags: 64 },
      });
      return;
    }

    const value = (interaction.data?.components?.[0]?.components?.[0]?.value as string) ?? "";
    this.pendingComponents.delete(nonce);
    pending.resolve(value);
    respondJson(res, {
      type: 4,
      data: { content: `✏️ 回答を受け付けました: ${value.slice(0, 200)}` },
    });
  }

  // ─── InteractionBridge 実装 (A-2: 権限確認) ───

  async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    const ctx = this.current;
    if (!ctx) throw new Error("Discord の会話コンテキストがありません");

    const timeoutMs = (this.config.interactionTimeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    const nonce = makeNonce("p");
    const summary = req.summary.length > 1500 ? req.summary.slice(0, 1500) + "..." : req.summary;

    const msg = await this.postFollowUp(ctx.token, {
      content: `🔒 **権限確認** \`${req.toolName}\`\n\`\`\`\n${summary}\n\`\`\``,
      components: [
        {
          type: 1, // ACTION_ROW
          components: [
            { type: 2, style: 3, label: "許可 (今回のみ)", custom_id: `lllm:${nonce}:allow_once` },
            { type: 2, style: 1, label: "許可 (セッション中)", custom_id: `lllm:${nonce}:allow_session` },
            { type: 2, style: 4, label: "拒否", custom_id: `lllm:${nonce}:deny` },
          ],
        },
      ],
    });

    const choice = await this.waitForComponent(nonce, ctx.userId, "permission", undefined, timeoutMs, ctx.token, msg?.id);
    if (choice === null) {
      throw new Error(`権限確認がタイムアウトしました (${timeoutMs / 1000}s)`);
    }
    return choice as PermissionDecision;
  }

  // ─── InteractionBridge 実装 (A-3: ask_user) ───

  async askUser(req: AskUserRequest): Promise<AskUserResponse> {
    const ctx = this.current;
    if (!ctx) throw new Error("Discord の会話コンテキストがありません");

    const timeoutMs = (this.config.interactionTimeoutSec ?? DEFAULT_TIMEOUT_SEC) * 2 * 1000;
    const nonce = makeNonce("a");
    const choices = req.choices ?? [];

    // 選択肢ボタン (1 行 4 個まで、 最大 3 行 = 12 個) + 自由入力ボタン
    const rows: any[] = [];
    const buttons = choices.slice(0, 12).map((label, i) => ({
      type: 2,
      style: 1,
      label: label.slice(0, 80),
      custom_id: `lllm:${nonce}:c${i}`,
    }));
    for (let i = 0; i < buttons.length; i += 4) {
      rows.push({ type: 1, components: buttons.slice(i, i + 4) });
    }
    rows.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: choices.length > 0 ? "その他 (自由入力)" : "回答を入力する",
          custom_id: `lllm:${nonce}:${MODAL_VALUE}`,
        },
      ],
    });

    const question = req.question.length > 1800 ? req.question.slice(0, 1800) + "..." : req.question;
    const msg = await this.postFollowUp(ctx.token, {
      content: `❓ ${question}`,
      components: rows,
    });

    const answer = await this.waitForComponent(nonce, ctx.userId, "ask", choices, timeoutMs, ctx.token, msg?.id);
    if (answer === null) throw new Error("ユーザー応答がタイムアウトしました");
    return { answer };
  }

  // ─── 待機・送信ヘルパー ───

  /** ボタン押下 / Modal 送信を待つ。 タイムアウト時は null を返しメッセージのボタンを除去する */
  private waitForComponent(
    nonce: string,
    requesterId: string,
    kind: "permission" | "ask",
    choices: string[] | undefined,
    timeoutMs: number,
    token: string,
    messageId: string | undefined,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingComponents.delete(nonce)) {
          resolve(null);
          if (messageId) {
            this.editFollowUp(token, messageId, {
              content: "⏱ タイムアウトしました（操作は実行されません）",
              components: [],
            }).catch(() => {});
          }
        }
      }, timeoutMs);
      this.pendingComponents.set(nonce, {
        requesterId,
        kind,
        choices,
        resolve: (v: string) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
    });
  }

  /** 新しい follow-up メッセージを投稿する (権限確認・ask_user 用) */
  private async postFollowUp(token: string, payload: Record<string, unknown>): Promise<any | null> {
    const appId = this.config.applicationId;
    if (!appId) {
      throw new Error("Discord applicationId が未設定のため follow-up を送信できません");
    }
    const url = `${DISCORD_API}/webhooks/${appId}/${token}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "lllmAgents/1.0",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord follow-up failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  /** follow-up メッセージを編集する (タイムアウト時のボタン除去用) */
  private async editFollowUp(token: string, messageId: string, payload: Record<string, unknown>): Promise<void> {
    const appId = this.config.applicationId;
    if (!appId) return;
    const url = `${DISCORD_API}/webhooks/${appId}/${token}/messages/${messageId}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "lllmAgents/1.0",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.error(`Discord follow-up edit failed: ${res.status} ${await res.text()}`);
    }
  }

  /** Discord interaction の元メッセージ (@original) を更新する (最終応答用) */
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

function respondJson(res: http.ServerResponse, payload: Record<string, unknown>): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function makeNonce(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** finalResponse が空のときの outcome 別フォールバック文言 */
function outcomeFallbackText(outcome: TaskOutcome): string {
  switch (outcome) {
    case "aborted":
      return "（処理が中断されました）";
    case "error":
      return "（エラーにより応答を生成できませんでした。サーバー側のログを確認してください）";
    case "max_iterations":
      return "（反復上限に達したため処理を打ち切りました）";
    default:
      return "（応答なし）";
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
