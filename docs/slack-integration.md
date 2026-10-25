# Slack統合 設計書

> **2026-10-25 更新**: REPL からの設定は `/integrations` → Slack 連携 の画面だけで行う。 直接コマンド `/slack` は削除した (docs/todo-legacy-ways-cleanup.md T3)。 Slack 経由で自動許可するツールは `/permission` の画面 → "Slack auto-approve tools" で編集する。 対話できる端末が無いときは `~/.localllm/config.json` の `slack.*` / `security.slackAutoApproveTools` を直接編集する。

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
| 通知のみ | 通常起動 + `/integrations` → Slack 連携 で通知オン | CLI使用中にLLM応答をSlack Webhookで通知 |
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
│   ├── repl.ts               # /integrations 画面 (Slack 連携メニュー)
│   └── integrations-settings.ts # 設定を書き換える関数
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

操作は `/integrations` → Slack 連携 の画面だけ (直接コマンドは無い)。 画面は状態を表示したうえで次を選べる。

| 項目 | 用途 |
|---|---|
| 通知をオンにする / オフにする | Webhook 通知の有効/無効 |
| 通知の送り先を設定する | Incoming Webhook URL |
| テスト通知を送ってみる | テスト通知送信 |
| Bot Token を設定する | `xoxb-` (--slack モード用) |
| App-Level Token を設定する | `xapp-` (--slack モード用) |
| 許可ユーザーを表示 / 追加 / 削除する | `allowedUserIds` (未設定だと誰も受け付けない) |

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
> /integrations   → Slack 連携 →「通知の送り先を設定する」「通知をオンにする」「テスト通知を送ってみる」

# Slackモード（全やりとりSlack経由）
npm run start
> /integrations   → Slack 連携 →「Bot Token を設定する」「App-Level Token を設定する」「許可ユーザーを追加する」
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

`/permission` の画面 → "Slack auto-approve tools" → "Add tool" でツールを追加する (権限の設定方法はこの画面だけ)。

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

## 更新履歴

- **2026-06-11 (A-2/A-3)**: インタラクティブ権限確認と ask_user ブリッジを実装。
  headless 制限が緩和され、ブリッジ経由で書き込み系ツールも確認付きで利用可能になった。
  認可 (allowedUserIds)・タイムアウト・本人限定ボタンを含む詳細は
  [channel-interaction-bridge-design.md](channel-interaction-bridge-design.md) を参照。
  上記「制約事項」のうち権限まわりの記述は A-2 以前の内容。
