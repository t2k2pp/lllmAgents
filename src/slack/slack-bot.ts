/**
 * Slack Bot (Socket Mode)
 *
 * Slack App の Socket Mode を使用してリアルタイムでメッセージを受信・応答する。
 * WebSocket接続のため公開URLは不要。
 *
 * A-2/A-3 (docs/channel-interaction-bridge-design.md): InteractionBridge を実装し、
 * 権限確認 (Block Kit ボタン) と ask_user (ボタン / スレッド返信) を Slack 上で行う。
 * これによりチャネル経由でも書き込み系ツールを安全に依頼できる。
 *
 * セットアップ手順:
 * 1. https://api.slack.com/apps でSlack Appを作成
 * 2. Socket Mode を有効化 → App-Level Token (xapp-...) を取得
 * 3. OAuth & Permissions で Bot Token Scopes を追加:
 *    app_mentions:read, chat:write, im:history, im:read
 * 4. Event Subscriptions → Subscribe to bot events:
 *    app_mention, message.im
 * 5. Interactivity & Shortcuts を ON (Socket Mode ならエンドポイント URL は不要)
 * 6. Install to Workspace → Bot User OAuth Token (xoxb-...) を取得
 * 7. lllmAgentsで設定:
 *    /slack bot-token xoxb-...
 *    /slack app-token xapp-...
 *    /slack user-add <SlackユーザーID>   (任意: 利用者を制限する場合)
 * 8. npm run start -- --slack で起動
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
import type { SlackConfig } from "../config/types.js";
import { markdownToSlackMrkdwn } from "../utils/slack.js";
import * as logger from "../utils/logger.js";

const SLACK_MAX_TEXT = 3000;
/** ask_user の「その他（自由入力）」ボタンの内部値 */
const OTHER_VALUE = "__other__";
/** 権限確認のデフォルトタイムアウト (秒)。 ask_user はこの 2 倍 */
const DEFAULT_TIMEOUT_SEC = 300;

/** 現在処理中の会話コンテキスト。 isProcessing で直列のため 1 つで足りる (A-5 で分離予定) */
interface ConversationContext {
  channel: string;
  /** スレッドルートの ts (確認メッセージ・応答の投稿先) */
  threadTs: string;
  /** 依頼者の Slack ユーザー ID (確認ボタン・回答はこの人のみ有効) */
  userId: string;
  isDM: boolean;
}

interface PendingAction {
  requesterId: string;
  kind: "permission" | "ask";
  /** ask の選択肢ラベル (value "c<idx>" の解決用) */
  choices?: string[];
  resolve: (value: string) => void;
}

interface PendingText {
  channel: string;
  threadTs: string;
  userId: string;
  isDM: boolean;
  resolve: (text: string) => void;
}

export class SlackBot implements InteractionBridge {
  private app: any = null; // @slack/bolt App instance (dynamic import)
  private _running = false;
  private current: ConversationContext | null = null;
  /** ボタン押下待ち: nonce → resolver */
  private pendingActions = new Map<string, PendingAction>();
  /** 自由入力 (スレッド返信) 待ち。 直列実行のため同時に 1 件 */
  private pendingText: PendingText | null = null;

  constructor(
    private config: SlackConfig,
    private agentLoop: AgentLoop,
  ) {}

  async start(): Promise<void> {
    if (this._running) return;
    if (!this.config.botToken || !this.config.appToken) {
      throw new Error("botToken と appToken が必要です（Socket Mode）");
    }

    // Dynamic import to avoid requiring @slack/bolt when not in slack mode
    const { App, LogLevel } = await import("@slack/bolt");

    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // 権限確認 / ask_user のボタン (action_id は lllm_act_ プレフィックス)
    this.app.action(/^lllm_act_/, async ({ action, body, ack, respond }: any) => {
      await ack();
      try {
        await this.handleAction(action, body, respond);
      } catch (e) {
        logger.error("Slack action handling error:", e);
      }
    });

    // @メンション（チャンネル内）
    this.app.event("app_mention", async ({ event, say }: any) => {
      await this.onMessage(event, say, false);
    });

    // ダイレクトメッセージ
    this.app.event("message", async ({ event, say }: any) => {
      // DM のみ処理（サブタイプなし = 通常メッセージ）
      if (event.channel_type === "im" && !event.subtype) {
        await this.onMessage(event, say, true);
      }
    });

    await this.app.start();
    this._running = true;
    // A-2/A-3: 対話ブリッジとして登録 (PermissionManager / ask_user が参照)
    setInteractionBridge("slack", this);
    logger.info("SlackBot started (Socket Mode)");
  }

  async stop(): Promise<void> {
    if (this.app) {
      setInteractionBridge("slack", null);
      await this.app.stop();
      this.app = null;
      this._running = false;
      logger.info("SlackBot stopped");
    }
  }

  get running(): boolean {
    return this._running;
  }

  // ─── 認可 (docs/channel-interaction-bridge-design.md §6) ───

  private isUserAllowed(userId: string): boolean {
    const allow = this.config.allowedUserIds;
    if (!allow || allow.length === 0) return true;
    return allow.includes(userId);
  }

  // ─── メッセージ受信 ───

  private async onMessage(event: any, say: (msg: any) => Promise<any>, isDM: boolean): Promise<void> {
    const text: string = event.text ?? "";
    const userId: string = event.user ?? "";
    const channel: string = event.channel;
    // スレッド返信なら thread_ts がルート。 ルート発言なら自分の ts がルートになる
    const threadRoot: string = event.thread_ts ?? event.ts;

    // @メンション部分を除去してプロンプトを抽出
    const prompt = text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();

    if (!this.isUserAllowed(userId)) {
      await say({
        text: ":no_entry: このボットの利用は許可されていません（allowedUserIds 設定）。",
        thread_ts: threadRoot,
      });
      return;
    }

    // A-3: ask_user の自由入力待ちへの回答ルーティング。
    // pending 中は同スレッド (DM は同チャネル)・依頼者本人の次メッセージを回答として消費する
    if (this.pendingText && prompt) {
      const p = this.pendingText;
      const matches = p.userId === userId &&
        p.channel === channel &&
        (p.isDM || p.threadTs === threadRoot);
      if (matches) {
        this.pendingText = null;
        p.resolve(prompt);
        return;
      }
    }

    if (!prompt) return;

    // 処理中チェック
    if (this.agentLoop.isProcessing) {
      await say({
        text: ":hourglass_flowing_sand: 別のリクエストを処理中です。少し待ってから再試行してください。",
        thread_ts: threadRoot,
      });
      return;
    }

    console.log(`\n  [Slack] <${userId}>: ${prompt}`);

    // 「処理中」インジケーター
    await say({
      text: ":hourglass_flowing_sand: 処理中...",
      thread_ts: threadRoot,
    });

    // AgentEventBus 購読で最終応答を受け取る (docs/agent-events-design.md §3.2)
    let finalResponse = "";
    let outcome: TaskOutcome = "incomplete";
    const off = this.agentLoop.events.on("task_complete", (e) => {
      finalResponse = e.finalResponse;
      outcome = e.outcome;
    });
    this.current = { channel, threadTs: threadRoot, userId, isDM };
    try {
      await this.agentLoop.run(prompt, { source: "slack" });

      const responseText = finalResponse.trim() || outcomeFallbackText(outcome);
      const converted = markdownToSlackMrkdwn(responseText);
      const chunks = splitMessage(converted, SLACK_MAX_TEXT);

      for (const chunk of chunks) {
        await say({ text: chunk, thread_ts: threadRoot });
      }
    } catch (e) {
      logger.error("Slack message processing error:", e);
      await say({
        text: `:x: エラー: ${e instanceof Error ? e.message : String(e)}`,
        thread_ts: threadRoot,
      });
    } finally {
      off();
      this.current = null;
    }
  }

  // ─── ボタン押下の処理 ───

  private async handleAction(action: any, body: any, respond: (msg: any) => Promise<any>): Promise<void> {
    const value = String(action?.value ?? "");
    const sep = value.indexOf(":");
    if (sep < 0) return;
    const nonce = value.slice(0, sep);
    const choice = value.slice(sep + 1);

    const pending = this.pendingActions.get(nonce);
    if (!pending) {
      // タイムアウト後の遅延クリックなど
      await respond({ text: "（この確認は期限切れです）", replace_original: true });
      return;
    }

    const clicker: string = body?.user?.id ?? "";
    if (clicker !== pending.requesterId) {
      // 依頼者以外のクリックは無視 (リプレイ・なりすまし防止)。 メッセージは維持
      logger.warn(`Slack: 依頼者以外のボタン操作を無視 (clicker=${clicker})`);
      return;
    }

    this.pendingActions.delete(nonce);

    let resolved: string;
    let display: string;
    if (pending.kind === "permission") {
      resolved = choice;
      display = choice === "allow_once"
        ? "✅ 許可 (今回のみ)"
        : choice === "allow_session"
          ? "✅ 許可 (セッション中)"
          : "⛔ 拒否";
    } else if (choice === OTHER_VALUE) {
      resolved = OTHER_VALUE;
      display = "✏️ 自由入力を選択";
    } else {
      const idx = parseInt(choice.slice(1), 10);
      resolved = pending.choices?.[idx] ?? choice;
      display = `✅ ${resolved}`;
    }

    pending.resolve(resolved);
    // 決定後はボタンを除去して結果を表示 (後からのクリック防止)
    const original = body?.message?.text ?? "確認";
    await respond({ text: `${original}\n→ ${display}`, replace_original: true });
  }

  // ─── InteractionBridge 実装 (A-2: 権限確認) ───

  async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    const ctx = this.current;
    if (!this.app || !ctx) throw new Error("Slack の会話コンテキストがありません");

    const timeoutMs = (this.config.interactionTimeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    const nonce = makeNonce("p");
    const summary = req.summary.length > 500 ? req.summary.slice(0, 500) + "..." : req.summary;

    const posted = await this.app.client.chat.postMessage({
      channel: ctx.channel,
      thread_ts: ctx.threadTs,
      text: `:lock: 権限確認: ${req.toolName}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:lock: *権限確認* \`${req.toolName}\`\n\`\`\`${summary}\`\`\``,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "許可 (今回のみ)" },
              style: "primary",
              action_id: "lllm_act_once",
              value: `${nonce}:allow_once`,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "許可 (セッション中)" },
              action_id: "lllm_act_session",
              value: `${nonce}:allow_session`,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "拒否" },
              style: "danger",
              action_id: "lllm_act_deny",
              value: `${nonce}:deny`,
            },
          ],
        },
      ],
    });

    const choice = await this.waitForAction(nonce, ctx.userId, "permission", undefined, timeoutMs, posted);
    if (choice === null) {
      throw new Error(`権限確認がタイムアウトしました (${timeoutMs / 1000}s)`);
    }
    return choice as PermissionDecision;
  }

  // ─── InteractionBridge 実装 (A-3: ask_user) ───

  async askUser(req: AskUserRequest): Promise<AskUserResponse> {
    const ctx = this.current;
    if (!this.app || !ctx) throw new Error("Slack の会話コンテキストがありません");

    const timeoutMs = (this.config.interactionTimeoutSec ?? DEFAULT_TIMEOUT_SEC) * 2 * 1000;
    const question = markdownToSlackMrkdwn(req.question);
    const replyHint = ctx.isDM
      ? "この DM に回答を返信してください。"
      : "このスレッドで bot をメンションして回答を返信してください。";

    if (req.choices && req.choices.length > 0) {
      const nonce = makeNonce("a");
      const elements = req.choices.slice(0, 10).map((label, i) => ({
        type: "button",
        text: { type: "plain_text", text: label.slice(0, 70) },
        action_id: `lllm_act_c${i}`,
        value: `${nonce}:c${i}`,
      }));
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "その他 (自由入力)" },
        action_id: "lllm_act_other",
        value: `${nonce}:${OTHER_VALUE}`,
      });

      const posted = await this.app.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: `:question: ${question}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:question: ${question}` } },
          { type: "actions", elements },
        ],
      });

      const choice = await this.waitForAction(nonce, ctx.userId, "ask", req.choices, timeoutMs, posted);
      if (choice === null) throw new Error("ユーザー応答がタイムアウトしました");
      if (choice !== OTHER_VALUE) return { answer: choice };
      // その他 → 自由入力の案内を出して返信待ちへ
      await this.app.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: `:speech_balloon: _（${replyHint}）_`,
      });
    } else {
      await this.app.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: `:speech_balloon: ${question}\n_（${replyHint}）_`,
      });
    }

    // 自由入力: スレッド返信を待つ (チャネルではメンション必須 — message.channels 未購読のため)
    const answer = await this.waitForText(ctx, timeoutMs);
    if (answer === null) throw new Error("ユーザー応答がタイムアウトしました");
    return { answer };
  }

  // ─── 待機ヘルパー ───

  /** ボタン押下を待つ。 タイムアウト時は null を返しメッセージのボタンを除去する */
  private waitForAction(
    nonce: string,
    requesterId: string,
    kind: "permission" | "ask",
    choices: string[] | undefined,
    timeoutMs: number,
    posted: { channel?: string; ts?: string },
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingActions.delete(nonce)) {
          resolve(null);
          // ボタンを除去してタイムアウトを表示 (失敗しても本処理には影響させない)
          if (posted.channel && posted.ts) {
            this.app?.client?.chat
              ?.update({
                channel: posted.channel,
                ts: posted.ts,
                text: "⏱ タイムアウトしました（操作は実行されません）",
                blocks: [],
              })
              .catch(() => {});
          }
        }
      }, timeoutMs);
      this.pendingActions.set(nonce, {
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

  /** スレッド返信 (自由入力) を待つ。 タイムアウト時は null */
  private waitForText(ctx: ConversationContext, timeoutMs: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingText) {
          this.pendingText = null;
          resolve(null);
        }
      }, timeoutMs);
      this.pendingText = {
        channel: ctx.channel,
        threadTs: ctx.threadTs,
        userId: ctx.userId,
        isDM: ctx.isDM,
        resolve: (t: string) => {
          clearTimeout(timer);
          resolve(t);
        },
      };
    });
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

/** 長いメッセージを分割する */
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
