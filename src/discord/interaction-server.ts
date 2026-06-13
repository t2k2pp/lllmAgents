/**
 * Discord Slash Command 受信 (Gateway 方式)
 *
 * Bot がこちらから Discord に WebSocket で接続し (gateway-client.ts)、
 * INTERACTION_CREATE イベントとして /ask・ボタン・Modal を受け取る。
 * 公開 URL・ポート開放・トンネルは不要 (docs/discord-gateway-design.md)。
 * interaction への初回応答は REST の callback エンドポイントに POST する。
 *
 * A-2/A-3 (docs/channel-interaction-bridge-design.md): InteractionBridge を実装し、
 * 権限確認 (Message Components ボタン) と ask_user (ボタン / Modal 自由入力) を
 * Discord 上で行う。
 *
 * セットアップ手順:
 * 1. Discord Developer Portal でアプリを作成し applicationId, botToken を取得
 *    → /discord app-id / /discord bot-token で設定
 * 2. 招待 URL (scope=bot+applications.commands) で Bot をサーバーに招待
 * 3. /discord register [サーバーID] でスラッシュコマンドを登録
 * 4. /discord listen start で受信開始
 *    (Developer Portal の Interactions Endpoint URL は空欄にしておくこと。
 *     設定されていると interaction が Gateway に届かない)
 * 5. /discord user-add <DiscordユーザーID> (任意: 利用者を制限する場合)
 *
 * 既知の制約: interaction token は 15 分で失効するため、 15 分を超える長時間タスクの
 * 途中では権限確認・follow-up を送信できない (docs/channel-interaction-bridge-design.md §9)。
 */

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
import { ChannelProgressTracker } from "../agent/channel-progress.js";
import { ConversationStore, ChannelRunQueue, waitForAgentIdle } from "../agent/channel-sessions.js";
import { maybePromoteToGoal } from "../agent/goal-promotion.js";
import type { DiscordConfig } from "../config/types.js";
import { DiscordGatewayClient } from "./gateway-client.js";
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
  private gateway: DiscordGatewayClient | null = null;
  private current: ConversationContext | null = null;
  /** ボタン押下 / Modal 送信待ち: nonce → resolver */
  private pendingComponents = new Map<string, PendingComponent>();
  /** A-5: チャンネル単位の会話ストア + 依頼の直列キュー */
  private conversations = new ConversationStore();
  private queue = new ChannelRunQueue();

  constructor(
    private config: DiscordConfig,
    private agentLoop: AgentLoop,
  ) {}

  /** Gateway に接続して受信を開始する */
  async start(): Promise<void> {
    if (this.gateway?.running) return;

    if (!this.config.botToken) {
      throw new Error("Bot Token が未設定です。'/discord bot-token <トークン>' で設定してください。");
    }

    this.gateway = new DiscordGatewayClient({
      botToken: this.config.botToken,
      onInteraction: (interaction) => void this.dispatchInteraction(interaction),
      onStatus: (message) => console.log(`  [Discord] ${message}`),
    });
    await this.gateway.start();

    // A-2/A-3: 対話ブリッジとして登録 (PermissionManager / ask_user が参照)
    setInteractionBridge("discord", this);
  }

  /** Gateway 接続を切って受信を停止する */
  stop(): void {
    if (this.gateway) {
      setInteractionBridge("discord", null);
      this.gateway.stop();
      this.gateway = null;
    }
  }

  get running(): boolean {
    return this.gateway?.running ?? false;
  }

  /** 接続中の Bot ユーザー名 (status 表示用) */
  get botUser(): string | null {
    return this.gateway?.botUser ?? null;
  }

  /** INTERACTION_CREATE を種類別に振り分ける */
  private async dispatchInteraction(interaction: any): Promise<void> {
    try {
      // APPLICATION_COMMAND (type: 2) - スラッシュコマンド
      if (interaction.type === 2) {
        await this.handleCommand(interaction);
        return;
      }
      // MESSAGE_COMPONENT (type: 3) - ボタン押下 (A-2/A-3)
      if (interaction.type === 3) {
        await this.handleComponent(interaction);
        return;
      }
      // MODAL_SUBMIT (type: 5) - 自由入力 Modal の送信 (A-3)
      if (interaction.type === 5) {
        await this.handleModalSubmit(interaction);
        return;
      }
      logger.warn(`Discord: 未対応の interaction type を受信しました: ${interaction.type}`);
    } catch (e) {
      logger.error("Discord interaction dispatch error:", e);
    }
  }

  /**
   * interaction への初回応答 (3 秒以内) を callback エンドポイントに POST する。
   * Endpoint 方式で HTTP レスポンスに書いていた payload をそのまま渡せる。
   */
  private async respondInteraction(interaction: any, payload: Record<string, unknown>): Promise<void> {
    const url = `${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`;
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
      throw new Error(`Discord interaction callback failed: ${res.status} ${text}`);
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
  private async handleCommand(interaction: any): Promise<void> {
    const commandName = interaction.data?.name;
    if (commandName !== "ask") {
      logger.warn(`Discord: 未対応のコマンドを受信しました: ${commandName}`);
      return;
    }

    const userId = DiscordInteractionServer.extractUserId(interaction);
    if (!this.isUserAllowed(userId)) {
      // flags 64 = ephemeral (本人にのみ見える)
      await this.respondInteraction(interaction, {
        type: 4,
        data: { content: "⛔ このボットの利用は許可されていません（allowedUserIds 設定）。", flags: 64 },
      });
      return;
    }

    // Discord の 3 秒ルール: まず deferred 応答を返す (type: 5)
    // その後非同期で処理して follow-up を送信する
    await this.respondInteraction(interaction, { type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE

    const prompt = interaction.data?.options?.[0]?.value as string ?? "";
    const token = interaction.token as string;
    const channelId = (interaction.channel_id as string) ?? "unknown";
    const username = interaction.member?.user?.username ?? interaction.user?.username ?? "Unknown";

    console.log(`\n  [Discord] ${username}: ${prompt}`);

    // A-5: 拒否せずキューに積む (docs/channel-session-queue-design.md §3)。
    // 注意: interaction token は 15 分で失効するため、 長いキュー待ちでは応答できないことがある
    const { position, result } = this.queue.enqueue(() =>
      this.processPrompt(prompt, token, userId, channelId),
    );
    if (position > 0) {
      this.sendFollowUp(
        token,
        `⏳ キューに追加しました（前に ${position} 件）。待ち時間が 15 分を超えると応答できない場合があります。`,
      ).catch(() => {});
    }
    result.catch((e) => {
      logger.error("Discord prompt processing error:", e);
      this.sendFollowUp(token, "❌ 処理中にエラーが発生しました。").catch(() => {});
    });
  }

  /** AgentLoop でプロンプトを処理し、Discord に結果を返す (キューにより直列実行される) */
  private async processPrompt(prompt: string, token: string, userId: string, channelId: string): Promise<void> {
    // CLI 操作中はジョブ開始を待つ (CLI 優先)
    await waitForAgentIdle(this.agentLoop);

    // AgentEventBus 購読で最終応答を受け取る (docs/agent-events-design.md §3.2)
    let completeEvent: import("../agent/agent-events.js").AgentEventMap["task_complete"] | null = null;
    const off = this.agentLoop.events.on("task_complete", (e) => {
      completeEvent = e;
    });
    // A-4: 進捗の中間報告。 deferred 応答 (@original) を編集し続け、 完了時に最終応答が上書きする
    const tracker = new ChannelProgressTracker((text) => this.sendFollowUp(token, text))
      .attach(this.agentLoop.events);
    // A-5: チャンネルの会話に載せ替え (CLI の会話は退避し、 finally で復帰する)
    const convKey = `discord:${channelId}`;
    const cliState = this.agentLoop.exportConversation();
    this.agentLoop.importConversation(this.conversations.get(convKey));
    this.current = { token, userId };
    try {
      // B-1: 複雑なタスクは Goal Seek への昇格をボタンで提案 (docs/goal-promotion-design.md)
      await maybePromoteToGoal({ input: prompt, source: "discord", agent: this.agentLoop });
      await this.agentLoop.run(prompt, { source: "discord" });
      tracker.detach();

      const e = completeEvent as import("../agent/agent-events.js").AgentEventMap["task_complete"] | null;
      const finalResponse = e?.finalResponse ?? "";
      const outcome: TaskOutcome = e?.outcome ?? "incomplete";
      let responseText = finalResponse.trim() || outcomeFallbackText(outcome);
      // A-6: ツールを使ったタスクには構造化フッターを付ける
      const footer = e ? formatReportFooter(e) : null;
      if (footer) responseText += `\n${footer}`;

      // Discord の 2000 文字制限に合わせて分割して送信。
      // 第 1 チャンクは @original を上書き (進捗表示が回答に変わる)、
      // 2 チャンク目以降は新規 follow-up (旧実装の同一メッセージ上書きバグを修正)
      const chunks = splitMessage(responseText, DISCORD_MAX_LENGTH);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await this.sendFollowUp(token, chunks[i]);
        } else {
          await this.postFollowUp(token, { content: chunks[i] }).catch((err) => {
            logger.error("Discord additional chunk failed:", err);
          });
        }
      }
    } catch (e) {
      logger.error("AgentLoop processing error:", e);
      throw e;
    } finally {
      tracker.detach();
      off();
      this.current = null;
      // A-5: チャンネルの会話を保存し、 CLI の会話を復帰する
      this.conversations.set(convKey, this.agentLoop.exportConversation());
      this.agentLoop.importConversation(cliState);
    }
  }

  // ─── コンポーネント (ボタン) / Modal ───

  /** ボタン押下 (custom_id: "lllm:<nonce>:<value>") */
  private async handleComponent(interaction: any): Promise<void> {
    const customId = (interaction.data?.custom_id as string) ?? "";
    if (!customId.startsWith("lllm:")) {
      logger.warn(`Discord: 未知のコンポーネントを受信しました: ${customId}`);
      return;
    }
    const rest = customId.slice("lllm:".length);
    const sep = rest.indexOf(":");
    const nonce = sep >= 0 ? rest.slice(0, sep) : rest;
    const value = sep >= 0 ? rest.slice(sep + 1) : "";

    const pending = this.pendingComponents.get(nonce);
    if (!pending) {
      await this.respondInteraction(interaction, {
        type: 4,
        data: { content: "（この確認は期限切れです）", flags: 64 },
      });
      return;
    }

    const clickerId = DiscordInteractionServer.extractUserId(interaction);
    if (clickerId !== pending.requesterId) {
      await this.respondInteraction(interaction, {
        type: 4,
        data: { content: "⛔ この確認は依頼者のみ操作できます。", flags: 64 },
      });
      return;
    }

    // 自由入力: Modal を開く (pending は維持し、 Modal 送信で解決する)
    if (value === MODAL_VALUE) {
      await this.respondInteraction(interaction, {
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
    await this.respondInteraction(interaction, {
      type: 7, // UPDATE_MESSAGE
      data: { content: `${original}\n→ ${display}`, components: [] },
    });
  }

  /** Modal 送信 (custom_id: "lllmmodal:<nonce>") */
  private async handleModalSubmit(interaction: any): Promise<void> {
    const customId = (interaction.data?.custom_id as string) ?? "";
    if (!customId.startsWith("lllmmodal:")) {
      logger.warn(`Discord: 未知の Modal を受信しました: ${customId}`);
      return;
    }
    const nonce = customId.slice("lllmmodal:".length);
    const pending = this.pendingComponents.get(nonce);
    if (!pending) {
      await this.respondInteraction(interaction, {
        type: 4,
        data: { content: "（この確認は期限切れです）", flags: 64 },
      });
      return;
    }

    const submitterId = DiscordInteractionServer.extractUserId(interaction);
    if (submitterId !== pending.requesterId) {
      await this.respondInteraction(interaction, {
        type: 4,
        data: { content: "⛔ この確認は依頼者のみ操作できます。", flags: 64 },
      });
      return;
    }

    const value = (interaction.data?.components?.[0]?.components?.[0]?.value as string) ?? "";
    this.pendingComponents.delete(nonce);
    pending.resolve(value);
    await this.respondInteraction(interaction, {
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
