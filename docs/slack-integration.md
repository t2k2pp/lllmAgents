# Slack統合 設計書

> **2026-05-28 更新**: REPL からの設定は `/integrations` (短縮: `/intg`) → Slack の picker 経由が canonical (Phase optimize #3 で Discord / Slack / Chatlog / Search を統合)。 本書中の `/slack xxx` は dispatcher 互換で引き続き動作するが、 補完候補からは外れている。 Slack-auto-approve ツールも `/permission` の picker から編集可能になった (旧 `/permission slack-add` は完全互換のため残存)。

## 概要

lllmAgentsにSlack統合を追加し、Slackを主要なインターフェースとして使用可能にする。
Discord統合と同様の2系統（通知送信 + メッセージ受信）を提供する。

## 技術選定

- **@slack/bolt** v4.x (Socket Mode)
  - WebSocket接続のため公開URLが不要（ローカルアプリに最適）
  - 自動再接続機能内蔵
  - Slack公式SDK

## アーキテクチャ

### 動作モード

| モード | 起動方法 | 説明 |
|--------|----------|------|
| 通知のみ | 通常起動 + `/slack enable` | CLI使用中にLLM応答をSlack Webhookで通知 |
| Slackモード | `--slack` フラグ | 全やりとりをSlack経由。CLIはexit/statusのみ |

### メッセージフロー

```
[通知モード]
  User → CLI (REPL) → AgentLoop → LLM応答
    → sendSlackNotification(webhook) → Slack チャンネル

[Slackモード]
  Slack User (@mention / DM)
    → Socket Mode (WebSocket)
    → SlackBot.handleMessage()
    → AgentLoop.run(prompt, { source: "slack" })
    → PermissionManager: slackAutoApproveTools のみ許可
    → LLM応答
    → Slack スレッド返信
```

### ファイル構成

```
src/
├── slack/
│   └── slack-bot.ts          # SlackBot クラス（Socket Mode）
├── utils/
│   └── slack.ts              # Webhook通知 + Markdown→mrkdwn変換
├── config/
│   └── types.ts              # SlackConfig インターフェース
├── security/
│   └── permission-manager.ts # RequestSource: "slack" + slackAutoApprove
├── agent/
│   └── agent-loop.ts         # getFilteredToolDefs slack対応
├── cli/
│   └── repl.ts               # /slack コマンド群
└── index.ts                  # --slack 起動フラグ
```

## 設定

### SlackConfig

```typescript
interface SlackConfig {
  enabled: boolean;     // Webhook通知の有効/無効
  webhookUrl: string;   // Incoming Webhook URL
  botToken?: string;    // xoxb- Bot User OAuth Token
  appToken?: string;    // xapp- App-Level Token (Socket Mode用)
}
```

### SecurityConfig 拡張

```typescript
slackAutoApproveTools: string[]  // Slack経由で自動許可するツール
```

デフォルト: `file_read, glob, grep, web_search, web_fetch, browser_snapshot, vision_analyze, current_datetime, sandbox_info`
（Discord と同一リスト）

## CLIコマンド

canonical な操作経路は `/integrations` → Slack の picker。 下表の `/slack xxx` 形式は dispatcher 互換のため残存 (補完候補からは外れている)。

### 通知設定

```
/integrations              picker から Slack を選択 → status / enable / disable / url / test
/slack status              設定状態表示 (alias)
/slack enable              Webhook通知有効化 (alias)
/slack disable             Webhook通知無効化 (alias)
/slack url <URL>           Incoming Webhook URL設定 (alias)
/slack test                テスト通知送信 (alias)
```

### Bot設定（--slackモード用）

```
/slack bot-token <xoxb-...>   Bot Token設定 (alias / または /integrations → Slack → Set Bot Token)
/slack app-token <xapp-...>   App-Level Token設定 (alias / または /integrations → Slack → Set App-Level Token)
```

## Slack App セットアップ手順

### 1. Slack App 作成

1. https://api.slack.com/apps → "Create New App" → "From scratch"
2. App名とワークスペースを選択

### 2. Socket Mode 有効化

1. "Socket Mode" → Enable Socket Mode
2. App-Level Token を生成（名前: 任意、Scope: `connections:write`）
3. 生成された `xapp-` トークンを控える

### 3. Bot Token Scopes 設定

"OAuth & Permissions" → Bot Token Scopes に以下を追加:

| Scope | 用途 |
|-------|------|
| `app_mentions:read` | チャンネルでの@メンション受信 |
| `chat:write` | メッセージ送信 |
| `im:history` | DMの履歴読み取り |
| `im:read` | DM受信 |

### 4. Event Subscriptions 設定

"Event Subscriptions" → Enable Events → Subscribe to bot events:

| Event | 用途 |
|-------|------|
| `app_mention` | チャンネルでの@メンション |
| `message.im` | ダイレクトメッセージ |

### 5. ワークスペースにインストール

"Install App" → "Install to Workspace"
→ Bot User OAuth Token (`xoxb-`) を控える

### 6. Incoming Webhooks（通知のみの場合）

通知だけ使う場合:
1. "Incoming Webhooks" → Activate Incoming Webhooks
2. "Add New Webhook to Workspace" → チャンネル選択
3. Webhook URL を控える

### 7. lllmAgents設定

```bash
# 通知のみ
npm run start
> /slack url https://hooks.slack.com/services/T.../B.../...
> /slack enable
> /slack test

# Slackモード（全やりとりSlack経由）
npm run start
> /slack bot-token xoxb-...
> /slack app-token xapp-...
> exit

npm run start -- --slack
```

## 権限モデル

Slack経由のリクエストはDiscordと同じheadlessモデル:

1. `INHERENTLY_SAFE_TOOLS` は常に許可
2. `slackAutoApproveTools` に含まれるツールは自動許可
3. `deny` ルールは強制適用（セキュリティ）
4. 上記以外のツールは拒否（インタラクティブ確認不可のため）
5. ファイル操作はサンドボックスチェック適用

`/permission` の picker → "Slack auto-approve tools" → "Add tool" でツール追加可能。 旧仕様の `/permission slack-add <tool>` は dispatcher 上で **未公開** のまま `permission-manager` 側だけに API があった (Phase optimize #1 で picker から初めて UI 露出した)。

## 制限事項・将来拡張

### 現行制限

- **シングルセッション**: 全Slackメッセージが同一のAgentLoop/MessageHistoryを共有
- **並行処理不可**: 処理中に別メッセージが来た場合は「処理中」と返信
- **ファイル添付未対応**: テキストメッセージのみ処理

### 将来拡張候補

- **スレッド別セッション**: Slackスレッドごとに独立したMessageHistoryを管理
- **ファイル添付対応**: Slackからのファイルアップロードをコンテキストに含める
- **リアクション操作**: 処理完了時にリアクション追加
- **Slash Command**: Slack側のスラッシュコマンド `/ask` 対応
- **インタラクティブ権限確認**: Slack Buttonで権限確認UI
