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
import type { SlackConfig } from "../config/types.js";
export declare class SlackBot {
    private config;
    private agentLoop;
    private app;
    private _running;
    constructor(config: SlackConfig, agentLoop: AgentLoop);
    start(): Promise<void>;
    stop(): Promise<void>;
    get running(): boolean;
    private handleMessage;
    /** メッセージ履歴から最後のアシスタント応答を取得 */
    private extractLastResponse;
}
//# sourceMappingURL=slack-bot.d.ts.map