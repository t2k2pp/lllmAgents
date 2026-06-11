# チャネルセッション分離とリクエストキュー 設計書 (A-5)

作成日: 2026-06-12
対応提案: docs/autonomy-improvement-proposal.md §4.1 A-5
ステータス: 実装済み

## 1. 背景と目的

- チャネル (Slack/Discord) の会話は CLI と**同一の MessageHistory を共有**しており、
  文脈が混線する（CLI で開発作業中に Slack から質問すると、開発文脈に混ざって応答する）
- `isProcessing` 中の依頼は即拒否され、ユーザーが手動で再試行する必要があった

**A-5: 会話コンテキストを「会話キー」単位に分離し、依頼は拒否せずキューに積む。**

## 2. 会話の分離 — ConversationState のスワップ

### 会話キー

| ソース | キー | 粒度 |
|--------|------|------|
| Slack | `slack:<channel>:<threadTs>` | スレッド = 1 会話（DM はメッセージごとにスレッド化しない場合チャネル単位） |
| Discord | `discord:<channelId>` | チャンネル = 1 会話 |
| CLI | （スワップ対象外 = AgentLoop の現用状態） | 従来どおり |

### スワップ機構 (AgentLoop)

会話状態は「履歴 + ToDo + Goal slot + mode」の 4 点セット
（docs/todo-goal-lifecycle.md の session 境界と同じ範囲）:

```ts
exportConversation(): ConversationState   // 現用状態への参照を取り出す
importConversation(state | null): void    // 載せ替え (null = 新規会話)
```

- **MessageHistory はオブジェクトごと保持・スワップ**する（restoreSession のような
  メッセージ再生ではないため thinking/ephemeral も無劣化）
- todos / goal slot は module singleton のため、スワップ時に set/clear で同期する
- chatLogger コールバックは import 時に再適用する

### チャネルジョブの実行手順

```
1. cliState = agentLoop.exportConversation()     // CLI の会話を退避
2. agentLoop.importConversation(store.get(key))  // スレッドの会話を復元 (無ければ新規)
3. agentLoop.run(prompt, { source })
4. store.set(key, agentLoop.exportConversation())  // スレッド会話を保存
5. agentLoop.importConversation(cliState)          // CLI の会話を復帰
```

キュー（§3）により 1 ジョブずつ実行されるため、スワップ中の競合はない。

## 3. リクエストキュー — ChannelRunQueue

- FIFO の Promise チェーン。チャネルの依頼は拒否せず enqueue し、
  待ちがある場合は「⏳ キューに追加しました（前に N 件）」と即時通知する
- ジョブ失敗はチェーンを壊さない（次のジョブは実行される）
- ジョブ開始前に `waitForAgentIdle`: CLI 操作（isProcessing=true）が終わるまで 500ms ポーリングで
  待機する（CLI 優先。逆方向 = チャネル実行中の CLI 入力ブロックは REPL 側の既存挙動）

## 4. ConversationStore

- in-memory LRU。上限 20 会話（超過時は最も古い会話を破棄）
- **プロセス再起動で消える**（チャネル会話の永続化はしない）。
  永続化が必要になったら session-manager 形式での保存を後続課題とする

## 5. 変更ファイル

| ファイル | 変更 |
|----------|------|
| `src/agent/channel-sessions.ts` | 新規。ConversationStore / ChannelRunQueue / waitForAgentIdle |
| `src/agent/agent-loop.ts` | exportConversation / importConversation |
| `src/slack/slack-bot.ts` | スレッド単位の会話 + キュー化（isProcessing 拒否を廃止） |
| `src/discord/interaction-server.ts` | チャンネル単位の会話 + キュー化（同上） |
| `tests/agent/channel-sessions.test.ts` | キュー（直列・順序・エラー耐性）と LRU |

## 6. 既知の制約・後続課題

- チャネル会話は in-memory（再起動で消える）。`/sessions` にも出ない
- Discord は interaction token が 15 分で失効するため、キュー待ち + 実行が 15 分を超えると
  応答を届けられない（キュー追加通知でその旨を案内）
- 複数ユーザーの同時利用はキューで直列化される（ローカル GPU 前提のため並列実行はしない）
- progress (A-4) / 権限確認 (A-2) は「実行中ジョブの会話」に紐づく（current コンテキスト）
