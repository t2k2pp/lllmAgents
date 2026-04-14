# チャットログ保存機能 設計書

## 概要

ユーザーとAIの会話ログをObsidian Vaultに自動保存する機能。
ナレッジベース（`/knowledge`）とは別のVault/ディレクトリに保存可能。

## 要件

- 有効/無効の切り替え（`/chatlog enable` / `disable`）
- ナレッジベースとは独立したVaultパス指定
- セッションごとにファイルを分離
- コンテキスト圧縮前後でファイルを分割（Part 1, 2, ...）
- ファイル名は日時ベース

## 設定

### Config (`config.json`)

```json
{
  "chatLog": {
    "enabled": true,
    "vaultPath": "C:/Users/xxx/ObsidianVault"
  }
}
```

### ChatLogConfig インターフェース

```typescript
interface ChatLogConfig {
  enabled: boolean;
  vaultPath: string;
}
```

## ファイル構成

```
<vaultPath>/
  ChatLogs/
    2026-04/
      20260414-153022.md          ← セッション Part 1
      20260414-153022_part2.md    ← 圧縮後の Part 2
      20260414-153022_part3.md    ← 2回目の圧縮後
    2026-05/
      ...
```

### ファイル構造

```markdown
---
title: "Chat Log 20260414-153022"
date: 2026-04-14T15:30:22.000Z
part: 1
tags:
  - chatlog
  - lllmagents
---

# Chat Log — 2026/4/14 15:30:22

## 👤 User (15:30:22)

テトリスを作って

## 🤖 Assistant (15:30:25)

> **Tools:** file_write, bash

テトリスを実装します...

---

> **📦 コンテキスト圧縮 (16:45:00)**
> ここまでの 42 メッセージが圧縮されました。
> 続きは Part 2 へ。
```

## CLIコマンド

| コマンド | 説明 |
|----------|------|
| `/chatlog` | ステータス表示 |
| `/chatlog vault <path>` | Vault パスを設定（自動で enabled） |
| `/chatlog enable` | チャットログ ON |
| `/chatlog disable` | チャットログ OFF |

## アーキテクチャ

### クラス: `ChatLogger` (`src/agent/chat-logger.ts`)

- コンストラクタ: `ChatLogConfig` を受け取り、セッションファイルを作成
- `logUser(message)`: ユーザーメッセージを追記
- `logAssistant(message, toolSummary?)`: AI応答を追記
- `onCompressed()`: 現ファイルに圧縮マーカー追記 → 新パートファイルに切替
- `setEnabled(boolean)`: 有効/無効切替

### 統合ポイント

1. **index.ts**: `config.chatLog` が有効なら `ChatLogger` を生成し `agent.setChatLogger()` で注入
2. **agent-loop.ts**:
   - `run()` 冒頭: ユーザーメッセージを `chatLogger.logUser()` で記録
   - `MessageHistory.addAssistantMessage` コールバック: AI応答を `chatLogger.logAssistant()` で記録
   - `contextManager.compress()` 成功後: `chatLogger.onCompressed()` でパート分割
3. **repl.ts**: `/chatlog` コマンドで設定・状態確認

### データフロー

```
User入力 → agent-loop.run()
  ├─ chatLogger.logUser()     ← ユーザーメッセージ記録
  ├─ history.addAssistantMessage() callback
  │   └─ chatLogger.logAssistant()  ← AI応答記録
  └─ contextManager.compress() 成功時
      └─ chatLogger.onCompressed()  ← パート分割
```

## 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/config/types.ts` | `ChatLogConfig` インターフェース追加、Config に `chatLog` フィールド |
| `src/agent/chat-logger.ts` | 新規: ChatLogger クラス |
| `src/agent/message-history.ts` | `AssistantMessageCallback` 型追加、コールバック機構 |
| `src/agent/agent-loop.ts` | `chatLogger` フィールド、`setChatLogger`/`getChatLogger`、圧縮時のパート分割 |
| `src/cli/repl.ts` | `/chatlog` コマンド |
| `src/cli/completer.ts` | `/chatlog` 補完候補 |
| `src/index.ts` | `ChatLogger` 初期化・注入 |
