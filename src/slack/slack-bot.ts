/**
 * Slack Bot (Socket Mode)
 *
 * Slack App の Socket Mode を使用してリアルタイムでメッセージを受信・応答する。
 * WebSocket接続のため公開URLは不要。
 *
 * セットアップ手順:
 * 1. https://api.slack.com/apps でSlack Appを作成
 * 2. Socket Mode を有効化 → App-Level Token (xapp-...) を取得
 * 3. OAuth & Permissions で Bot Token Scopes を追加:
 *    app_mentions:read, chat:write, im:history, im:read
 * 4. Event Subscriptions → Subscribe to bot events:
 *    app_mention, message.im
 * 5. Install to Workspace → Bot User OAuth Token (xoxb-...) を取得
 * 6. lllmAgentsで設定:
 *    /slack bot-token xoxb-...
 *    /slack app-token xapp-...
 * 7. npm run start -- --slack で起動
 */

import type { AgentLoop } from "../agent/agent-loop.js";
import type { TaskOutcome } from "../agent/agent-events.js";
import type { SlackConfig } from "../config/types.js";
import { markdownToSlackMrkdwn } from "../utils/slack.js";
import * as logger from "../utils/logger.js";

const SLACK_MAX_TEXT = 3000;

export class SlackBot {
  private app: any = null; // @slack/bolt App instance (dynamic import)
  private _running = false;

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

    // @メンション（チャンネル内）
    this.app.event("app_mention", async ({ event, say }: any) => {
      await this.handleMessage(event.text, event.channel, event.ts, event.user, say);
    });

    // ダイレクトメッセージ
    this.app.event("message", async ({ event, say }: any) => {
      // DM のみ処理（サブタイプなし = 通常メッセージ）
      if (event.channel_type === "im" && !event.subtype) {
        await this.handleMessage(event.text, event.channel, event.ts, event.user, say);
      }
    });

    await this.app.start();
    this._running = true;
    logger.info("SlackBot started (Socket Mode)");
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      this._running = false;
      logger.info("SlackBot stopped");
    }
  }

  get running(): boolean {
    return this._running;
  }

  private async handleMessage(
    text: string,
    _channel: string,
    threadTs: string,
    userId: string,
    say: (msg: any) => Promise<any>,
  ): Promise<void> {
    // @メンション部分を除去してプロンプトを抽出
    const prompt = (text ?? "").replace(/<@[A-Z0-9]+>\s*/g, "").trim();
    if (!prompt) return;

    // 処理中チェック
    if (this.agentLoop.isProcessing) {
      await say({
        text: ":hourglass_flowing_sand: 別のリクエストを処理中です。少し待ってから再試行してください。",
        thread_ts: threadTs,
      });
      return;
    }

    console.log(`\n  [Slack] <${userId}>: ${prompt}`);

    // 「処理中」インジケーター
    await say({
      text: ":hourglass_flowing_sand: 処理中...",
      thread_ts: threadTs,
    });

    // AgentEventBus 購読で最終応答を受け取る (docs/agent-events-design.md §3.2)。
    // 履歴の逆順スキャン + think タグ除去の重複実装は廃止 (finalResponse は除去済み)。
    let finalResponse = "";
    let outcome: TaskOutcome = "incomplete";
    const off = this.agentLoop.events.on("task_complete", (e) => {
      finalResponse = e.finalResponse;
      outcome = e.outcome;
    });
    try {
      await this.agentLoop.run(prompt, { source: "slack" });

      const responseText = finalResponse.trim() || outcomeFallbackText(outcome);
      const converted = markdownToSlackMrkdwn(responseText);
      const chunks = splitMessage(converted, SLACK_MAX_TEXT);

      for (const chunk of chunks) {
        await say({ text: chunk, thread_ts: threadTs });
      }
    } catch (e) {
      logger.error("Slack message processing error:", e);
      await say({
        text: `:x: エラー: ${e instanceof Error ? e.message : String(e)}`,
        thread_ts: threadTs,
      });
    } finally {
      off();
    }
  }
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
