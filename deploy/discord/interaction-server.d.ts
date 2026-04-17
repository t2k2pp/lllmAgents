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
import type { AgentLoop } from "../agent/agent-loop.js";
import type { DiscordConfig } from "../config/types.js";
export declare class DiscordInteractionServer {
    private config;
    private agentLoop;
    private server;
    private _running;
    constructor(config: DiscordConfig, agentLoop: AgentLoop);
    /** HTTP サーバーを起動する */
    start(): Promise<void>;
    /** HTTP サーバーを停止する */
    stop(): void;
    get running(): boolean;
    /** Discord の Ed25519 署名を検証する (Node.js 18+ 組み込み crypto.subtle 使用) */
    private verifySignature;
    /** /ask コマンドを処理する */
    private handleCommand;
    /** AgentLoop でプロンプトを処理し、Discord に結果を返す */
    private processPrompt;
    /** Discord interaction の follow-up メッセージを送信する */
    private sendFollowUp;
}
//# sourceMappingURL=interaction-server.d.ts.map