# チャネル対話ブリッジ設計書 (A-2 権限確認 / A-3 ask_user)

作成日: 2026-06-11
対応提案: docs/autonomy-improvement-proposal.md §4.1 A-2, A-3
前提: docs/agent-events-design.md (A-1) の InteractionBridge 型
ステータス: 実装済み
更新 (2026-06-13): Discord の受信は Endpoint 方式から Gateway 方式 (WebSocket) に
切り替えた (docs/discord-gateway-design.md)。本書の対話フロー (ボタン/Modal/
follow-up) は受信経路に依存しないため設計はそのまま有効。

## 1. 背景と目的

現状の Discord / Slack は headless モード: 確認 UI が無いため、許可リスト
(discord/slackAutoApproveTools + INHERENTLY_SAFE_TOOLS) 外のツールは即拒否され、
ツール定義自体もモデルから隠される。書き込み系タスクをチャネルから頼めず、
ask_user も使えないため「聞かずに進むか、止まるか」の二択になっていた。

**A-2: 権限確認をチャネルのボタン UI にブリッジし、チャネルから書き込み系タスクを安全に依頼可能にする。**
**A-3: ask_user を同じ仕組みでブリッジし、「不明点は聞く」原則をチャネルでも機能させる。**

## 2. アーキテクチャ

```
PermissionManager.checkToolPermission(source=slack)
  └─ チャネルフロー: 自動許可セットに無い
       └─ InteractionBridgeRegistry.get("slack") ─ あり → bridge.requestPermission()
            └─ SlackBot: Block Kit ボタン送信 → クリック待ち (タイムアウト付き) → 決定
       └─ ブリッジ無し → 従来どおり拒否 (headless 互換)

ask_user ツール (context.source=slack)
  └─ InteractionBridgeRegistry.get("slack").askUser()
       └─ SlackBot: 選択肢ボタン / スレッド返信待ち
```

- **InteractionBridgeRegistry** (`src/agent/interaction-bridge-registry.ts`):
  source → InteractionBridge の module singleton。goal-slot / todo-write と同じ思想で、
  多数のコンストラクタへ bridge を引き回さない
- SlackBot / DiscordInteractionServer が start() で自分を登録し、stop() で解除する
- イベント（通知・一方向、A-1）と対話（要求・応答、本書）は別機構

## 3. 権限フロー (A-2)

`PermissionManager.checkChannelPermission(source, toolName, params)` に discord/slack を統合:

1. **deny ルール** → 拒否（従来どおり、ブリッジでも覆せない強制）
2. **自動許可**: INHERENTLY_SAFE + 当該チャネルの autoApprove + チャネルセッション許可
   → サンドボックスチェックの上で許可（従来どおり）
3. ブリッジ未登録 → 従来の拒否メッセージ（headless 互換）
4. **セッション承認キャッシュ** (`source:tool:paramsHash`) → 許可
5. **危険コマンド** (bash): block レベル → 拒否 / warn レベル → 確認文に警告を併記
6. **サンドボックス** (file_write / file_edit / browser_screenshot save_path) → 外なら拒否
7. **ブリッジ確認** (既存 _permissionQueue で直列化):
   - `allow_once` → paramsHash キャッシュに追加して許可（CLI の「今回のみ」と同じ）
   - `allow_session` → チャネル別セッション許可セットに追加して許可
   - `deny` → CLI 拒否と同じ「対話を促す」理由文を返す
   - タイムアウト / 例外 → 拒否

設計判断:
- **「設定に保存して常に許可」(permanent) はチャネルでは提供しない**。永続変更は CLI でのみ
  （リモートからの永続的な権限昇格を防ぐ）
- autorun / 封じ込め自動許可の分岐はチャネルフローには適用しない（保守的に倒す）
- allow ルール (rules.allow) もチャネルでは従来どおり評価しない（denyのみ強制）

## 4. ask_user ブリッジ (A-3)

- `ToolExecutionContext` に `source?: RequestSource` を追加し、ToolExecutor が実行時に渡す
- ask_user は source が discord/slack のとき bridge.askUser() に委譲。ブリッジ未登録なら
  ツール自体が公開されない（§5）ため到達しない
- **Slack**: 選択肢 → ボタン + 「その他（自由入力）」ボタン（押すとスレッド返信を促す）。
  選択肢なし / multiSelect → スレッド返信待ち（multiSelect はカンマ区切り番号 or 自由文）。
  返信の解釈: pending 中は同スレッド・同ユーザーの次メッセージを回答として消費する
- **Discord**: 選択肢 → ボタン。自由入力 → 「回答を入力する」ボタン → Modal (TEXT_INPUT)。
  （interaction ベースの受信ではメッセージイベントを購読しないため Modal を使う。
  Gateway 方式移行後も intents=0 で運用しており同じ理由で Modal を維持）
- タイムアウト → ツール失敗（"ユーザー応答タイムアウト"）として返し、モデルに状況を伝える

## 5. ツール公開の緩和

`getFilteredToolDefs()`: ブリッジ（requestPermission 実装）があるチャネルでは、従来の
許可リストフィルタをやめて CLI とほぼ同等のツールを公開する。ただし以下は除外:

| 除外ツール | 理由 |
|-----------|------|
| `enter_plan_mode` / `exit_plan_mode` | exit_plan_mode の承認 UI が inquirer 直結（サーバー端末でハング）。プランモードのチャネル対応は後続 |
| `task` / `second_llm_agent` | サブエージェントの ToolExecutor が source を継承せず CLI 確認に流れる（ハング）。source 伝播は後続課題 |
| `ask_user` | bridge.askUser 実装時のみ公開 |

※ ユーザーが明示的に channel autoApprove に task 等を追加した場合は従来どおり公開される
（headless 実行、従来挙動の維持）。

## 6. 認可（なりすまし対策）

- `DiscordConfig.allowedUserIds` / `SlackConfig.allowedUserIds` (string[]) を新設
  - 設定済み: リスト外ユーザーのコマンド/メッセージは即拒否（応答文で明示）
  - 未設定: 従来どおり誰でも会話可能（後方互換）。ただし**確認ボタン/回答は常に依頼者本人のみ有効**
    （他ユーザーのクリックは無視し、その旨を ephemeral / 別メッセージで通知）
- 決定後はメッセージを編集してボタンを除去（後からのクリック・リプレイ防止）
- REPL: `/slack user-add <id>` `/slack user-remove <id>` `/slack users`（/discord も同様）

## 7. タイムアウト

- 権限確認: `interactionTimeoutSec` (config、デフォルト 300s) → deny + メッセージ更新
- ask_user: 同設定の 2 倍 (デフォルト 600s) → ツール失敗
- 1 確認 = 1 nonce。決定済み nonce への遅延クリックは無視

## 8. 変更ファイル

| ファイル | 変更 |
|----------|------|
| `src/agent/interaction-bridge-registry.ts` | 新規。registry |
| `src/security/permission-manager.ts` | checkChannelPermission 統合 + ブリッジフロー |
| `src/tools/tool-registry.ts` | ToolExecutionContext.source 追加 |
| `src/tools/tool-executor.ts` | source を context へ |
| `src/tools/definitions/ask-user.ts` | チャネルブリッジ経路 |
| `src/agent/agent-loop.ts` | getFilteredToolDefs のブリッジ対応 |
| `src/slack/slack-bot.ts` | ブリッジ実装 (Block Kit / 返信ルーティング / 認可) |
| `src/discord/interaction-server.ts` | ブリッジ実装 (Components / Modal / 認可) |
| `src/config/types.ts` | allowedUserIds / interactionTimeoutSec |
| `src/cli/repl.ts` | /slack /discord の user-add/user-remove/users |
| tests | interaction-bridge-registry / permission channel flow / ask_user 経路 |

## 9. 既知の制約・後続課題

- サブエージェント (task / second_llm_agent) への source 伝播は未対応 → チャネルでは非公開。
  channel autoApprove に手動追加した場合、サブエージェントが ask 級ツールに触れると
  サーバー端末側で確認待ちになる既存挙動は残る（A-2 以前からの挙動）
- Slack の multiSelect はボタンでなくテキスト返信で代替（Block Kit の checkbox は
  モーダル化が必要で Phase 1 では見送り）
- 進捗の可視化（確認待ちで止まっていること自体の通知）は A-4 で扱う
- 複数同時リクエスト（スレッド分離）は A-5 で扱う。現状は isProcessing で直列
