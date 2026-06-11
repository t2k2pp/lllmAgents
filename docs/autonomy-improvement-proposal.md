# 他エージェントアプリ比較と自律性向上の改善提案

作成日: 2026-06-11
作成者: Claude Code (Fable 5) — ユーザーレビュー前のドラフト
ステータス: **提案（優先度はユーザー見直し待ち）**

## 1. 目的と経緯

本アプリ (lllmAgents) の設計・実装を確認し、他のエージェントアプリと比較した強みを整理する。
そのうえで「ユーザーの指示から意図・目的を理解し、自律性高く行動するエージェント」を目指す改善案を、
**Discord / Slack 統合の強化を重点**として優先度付きで提案する。
優先度は Claude の判断であり、ユーザーが §5 の表で見直して確定する。

### 確認した範囲

- エージェントコア: `src/agent/` (agent-loop, system-prompt, goal-slot, intent-classifier,
  harness-intervention, capability-tier, progress-judge, tool-call-normalizer ほか)
- チャネル統合: `src/discord/interaction-server.ts`, `src/slack/slack-bot.ts`, `src/utils/discord.ts`
- 権限モデル: `src/security/permission-manager.ts` (headless モード、discord/slackAutoApprove)
- ツール群: `src/tools/definitions/` (24種)、スキル (18種)、README.md、docs 配下の主要設計書

## 2. 他エージェントアプリとの比較 — 良い点

比較対象: Claude Code (Anthropic)、OpenHands、Aider、Goose (Block)、OpenClaw 系チャネルボット、
AutoGPT 系自律ループ。比較軸は「自律性」「ハーネス工学」「ローカルLLM適応」「チャネル統合」「拡張性」。

### 2.1 ローカルLLM向けハーネス工学の体系化（最大の強み）

「弱いモデルをハーネスで支えて実用水準に引き上げる」仕組みが、他のどのアプリよりも体系的:

- **capability tier 別システムプロンプト** (T1=Claude級 / T2=27B / T3=7B) — モデル能力に応じて
  指示の粒度を変える。Aider の edit format 切替より広い概念で、他に類例が少ない
- **tool call salvage / normalizer** — 崩れたツール呼び出しの救済。ローカルLLMの最大の躓きを吸収
- **失敗フィードバック工学** — file_edit 失敗時のファイル内容添付、file_write の構文チェック+
  インターフェース要約、テキストのみ応答のエスカレーション（3回で履歴削除、5回で中断）
- **ハーネス哲学の明文化** (`harness-intervention.ts`) — 「後付け警告の監視官介入を全廃し、
  原則はプロンプトで先に伝え、構造的境界は tool 側の hard gate で表現する」。
  試行錯誤の結果を設計思想として文書化・コード化している点は Claude Code の内部設計に通じる

OpenHands / AutoGPT 系は「強いモデル前提」で、モデルが弱いと崩壊する。本アプリは
27B クラスで実タスクを完遂させるための補強が随所にあり、これは明確な差別化要素。

### 2.2 Goal Seek mode — 検証可能なゴール駆動

`goal-slot.ts`: ゴールと acceptance criteria を**メッセージ履歴の外側**に保持し、
コンテキスト圧縮で劣化しない不変量として system prompt に注入。反復ごとに評価レコードを残し、
**収穫逓減検出**（スコア改善が止まり unmet 集合が変化しない）で無限ループを防ぐ。

AutoGPT 系の「ゴールを与えてループ」と違い、(1) criteria が検証可能な形に正規化される、
(2) response_complete を hard gate で拒否して未達完了を防ぐ、(3) 行き詰まりを定量検出する。
「指示から意図・目的を理解して行動する」方向への布石が既に入っている。

### 2.3 マルチモデルオーケストレーション

main / second LLM のプロファイル（モデル特性の自然言語記述）と**配置情報（別マシンなら並列可、
同一マシンなら GPU KV キャッシュ競合で直列推奨）**を system prompt に注入し、LLM 自身に
委任先を選ばせる。ローカルGPUクラスタの物理制約をプロンプトに反映する設計は他に見ない。

### 2.4 Claude Code 互換エコシステムの完成度

skills / rules / hooks / sub-agents / MCP / plan mode / セッション管理 / 永続メモリ /
3段階権限モデルを単一 exe 配布で実現。ビルトインスキル18種（TDD、コミット、PRレビュー等）は
「ワークフロー知識をモデルの外に持つ」という Claude Code と同じ思想で、弱いモデルほど効く。

### 2.5 「安全を根拠に自走させる」セキュリティ設計

OS レベル封じ込め（macOS sandbox-exec / Linux・WSL2 bubblewrap）+ ネット allowlist を前提に
bash 確認を自動許可する `/sandbox` は、「制限を増やす」のでなく**「封じ込めの保証を確認削減
（=自律性向上）に交換する」**設計。Claude Code の sandboxed bash と同方向で、OSS ローカル
エージェントとしては先進的。autorun モード、50+ 危険コマンドパターンも同じ思想の階段。

### 2.6 透明性・運用性

`/context`（カテゴリ別トークン内訳）、LLM I/O ログ (JSONL)、`/cost`、チャットログ、
LLM プロファイル履歴。 「silent な欠損禁止・全量注入で容量超過は API エラーで顕在化」
(`system-prompt.ts` のコメント) のような**失敗を見えるようにする方針**が一貫している。

### 2.7 チャネル統合を持つ開発エージェントという希少性

Discord (Slash Command + Webhook 通知) と Slack (Socket Mode) の双方向統合を持つ
CLI 開発エージェントはほぼ無い。OpenClaw 系はチャネル特化だが開発ツールではなく、
Claude Code もチャネル統合は持たない。**ただし現状は最終応答のみ返す Q&A 型で、
強みの種ではあるが完成形ではない**（§3 のギャップ参照）。

## 3. ギャップ分析 — 自律性を阻んでいる箇所

### 3.1 Discord / Slack（重点）

現状の構造: チャネル → `AgentLoop.run(prompt, {source})` → 完了後に**最後の assistant
メッセージだけ**を返す薄いラッパー。このため:

| # | ギャップ | 影響 |
|---|---------|------|
| G1 | **headless 権限**: 確認 UI が無いため、許可リスト外のツールはチャネル経由で一切使えない | 書き込み系タスクが実質不可。autoApprove に大量登録すると逆に無確認で危険 |
| G2 | **ask_user 不可**: 途中で人に聞けない | 「聞かずに勝手に進む」か「止まる」かの二択になり、自律性が歪む |
| G3 | **進捗の沈黙**: Slack は「処理中...」1回、Discord は deferred のみ。長時間タスクで完了まで無音 | ユーザーが生死を判断できず、信頼して任せられない |
| G4 | **単一セッション共有**: CLI と同じ会話履歴に混ざる。`isProcessing` 中は拒否 | 並行依頼不可、文脈混線、複数ユーザー非対応 |
| G5 | **ファイル送受信なし**: 成果物（画像・レポート）を渡せない、添付画像を受けられない | 「成果物を作るエージェント」の出口がチャネルに無い |
| G6 | **proactive 発信が通知 webhook のみ**: 完了報告の構造化（成果物パス・コスト・未達事項）が無い | 「任せて、あとで報告を受ける」運用ができない |

### 3.2 コア自律性

- intent-classifier は task/question/conversation の3分類まで。**目的の構造化（goal 化）は
  Goal Seek mode への明示移行が必要**で、通常パスでは「指示→意図→検証可能ゴール」の正規化が走らない
- メモリは `/remember` 手動中心で、タスクから学んだことを能動的に蓄積する仕組みがない

## 4. 改善提案

### 4.1 カテゴリ A: チャネル基盤（Discord/Slack 重点）

#### A-1. AgentLoop のイベント化 — ChannelAdapter 抽象（土台）

**ステータス: Phase 1 実装済み (2026-06-11)。個別設計書: [agent-events-design.md](agent-events-design.md)**
（AgentEventBus 新設・主要イベント発火・Slack/Discord アダプタの購読化まで。CLI 表示の購読者への
移設は Phase 2 = A-4 と同時に実施）

`agent-loop.ts` は console 出力と密結合（console.log / stdout 直書き 55箇所）。
ここにイベント境界を入れる:

```
AgentLoop ──emit──> AgentEvents
  onTaskStart / onToolStart / onToolEnd / onText
  onPermissionRequest(→Promise<決定>) / onAskUser(→Promise<回答>)
  onTaskComplete(summary, artifacts, cost) / onError

購読者: CliRenderer (既存表示をここへ移設) / SlackAdapter / DiscordAdapter
```

- CLI も同じイベントを購読する形に寄せ、「チャネル = もう一つのフロントエンド」にする
- A-2 以降すべての土台。これ無しで各機能を個別実装するとチャネルごとの分岐が agent-loop に増殖する

#### A-2. チャネル経由のインタラクティブ権限確認

**ステータス: 実装済み (2026-06-11)。個別設計書: [channel-interaction-bridge-design.md](channel-interaction-bridge-design.md)**

headless 拒否をやめ、`onPermissionRequest` を Slack Block Kit ボタン / Discord Message
Components（許可 / 今回のみ / 拒否）にブリッジする。

- タイムアウト（例 5分）で自動拒否。応答者の user ID を記録
- **なりすまし対策が前提**: 許可ボタンを押せるのは設定済み user ID allowlist のみ
- 効果: discord/slackAutoApprove に頼らず、書き込み系タスクをチャネルから安全に依頼できる。
  G1 の解消 = チャネル自律性の最大のアンロック

#### A-3. ask_user のチャネルブリッジ

**ステータス: 実装済み (2026-06-11)。個別設計書: [channel-interaction-bridge-design.md](channel-interaction-bridge-design.md)**

同じ仕組みで `ask_user` の質問・選択肢をボタン/スレッド返信にマップ。G2 解消。
「不明点は聞く」という system prompt の原則がチャネルでも機能するようになる。

#### A-4. 進捗の中間報告（スロットリング付き）

**ステータス: 実装済み (2026-06-11)。個別設計書: [channel-progress-design.md](channel-progress-design.md)**

- Slack: 「処理中...」メッセージを `chat.update` で更新（ツール名・経過ターン・ToDo進捗）
- Discord: deferred 応答の編集 + 長時間なら follow-up 追加
- rate limit 対策で更新は最小間隔（例 5〜10秒）+ 重要イベント（ツール完了・ToDo更新）のみ
- G3 解消。「沈黙しないエージェント」は任せる心理コストを大きく下げる

#### A-5. セッション分離とリクエストキュー

**ステータス: 実装済み (2026-06-12)。個別設計書: [channel-session-queue-design.md](channel-session-queue-design.md)**

- Slack スレッド / Discord チャンネル（またはユーザー）単位に会話コンテキストを分離。
  session-manager の保存・復元を流用し、スレッド ID → セッション ID をマップ
- `isProcessing` 拒否をやめ、キュー投入 + 「N番目です」通知。G4 解消
- 注: 完全並列はローカル GPU では逐次になるため、まず「キュー化 + 文脈分離」で十分

#### A-6. 完了報告の構造化と proactive 通知の一般化

**ステータス: 実装済み (2026-06-11)。個別設計書: [task-report-notification-design.md](task-report-notification-design.md)**

- `onTaskComplete` で成果物パス・実行ツールサマリ・コスト・所要時間・**未達事項**を構造化し、
  チャネルへ整形送信（response_complete の summary を活用）
- CLI で開始した長時間タスクの完了も同じ経路で Discord/Slack に届く（既存 webhook 通知の昇格）
- 「捏造・偽装禁止」「silent 欠損禁止」の原則をチャネル報告にも適用: できなかったことを明記

#### A-7. ファイル・画像の双方向転送

- 送信: 生成画像・スクリーンショット・レポートを Slack files API / Discord attachment で添付
- 受信: チャネル添付画像を vision ツールへ、テキストファイルをプロンプト文脈へ
- G5 解消。画像生成・browser_screenshot という既存の強みがチャネルで活きる

#### A-8. チャネル別 trust プロファイル

ユーザー ID / チャンネル ID ごとに権限プロファイル（readonly / autorun / full+確認）を設定。
`/sandbox` 封じ込めと組み合わせ、「このチャンネルからは封じ込め下で自走許可」のような
**安全保証と自律性の交換**をチャネルにも拡張する。

#### A-9. ジョブ投入型運用（fire-and-forget）

「帰宅までに X をやっておいて」→ ジョブ登録 → バックグラウンド実行 → 完了時スレッド報告。
A-2/A-4/A-6 が揃えば、キュー + セッション分離の上に薄く載る。`/loop` や将来のスケジュール
実行と統合すれば「常駐自律エージェント」の運用形態が完成する。

### 4.2 カテゴリ B: コア自律性

#### B-1. 指示 → ゴール正規化の標準パス化

intent-classifier が「task」かつ複雑度が高い場合、Goal Seek mode への昇格を自動提案:
意図・acceptance criteria を AI が要約 → ユーザー承認（チャネルではボタン）→ goal slot 設定。
「ユーザーの指示から意図・目的を理解する」を**明示的な正規化ステップ**として標準フローに
組み込む。既存の goal-slot / evaluator / progress-judge をそのまま活かせる。

#### B-2. メモリの能動活用

タスク完了時に「学んだこと・ユーザーの好み」の保存を提案（自動保存はしない —
knowledge_save と同じ「ユーザー指示時のみ」原則を維持しつつ、提案までは能動化）。
セッションを跨ぐほど意図理解が速くなるループを作る。

#### B-3. checkpoint × チャネル連携

失敗時のロールバック報告と「ここから再開して」指示をチャネルから受ける。
A-5 のセッション分離が前提。

## 5. 優先度一覧（Claude 案 → ユーザー見直し欄）

判断基準: 自律性向上への効果 × 実装コスト × 依存関係。
**A-1 が全チャネル改善の土台**のため最優先。次に「チャネルから安全に任せられる」を成立させる
A-2/A-3、可視性の A-4 を P0/P1 に置いた。

| ID | 内容 | 効果 | コスト | Claude案 | ユーザー確定 |
|----|------|------|--------|----------|--------------|
| A-1 | AgentLoop イベント化 (ChannelAdapter) | ◎ (土台) | 中 | **P0** | ✅ Phase 1 実装済み (2026-06-11) |
| A-2 | チャネル経由の権限確認 | ◎ | 中 | **P0** | ✅ 実装済み (2026-06-11) |
| A-3 | ask_user ブリッジ | ◎ | 小 (A-2と同基盤) | **P0** | ✅ 実装済み (2026-06-11) |
| A-4 | 進捗の中間報告 | ○ | 小〜中 | **P1** | ✅ 実装済み (2026-06-11) |
| A-5 | セッション分離 + キュー | ○ | 中 | **P1** | ✅ 実装済み (2026-06-12) |
| A-6 | 完了報告の構造化 + proactive 通知 | ○ | 小 | **P1** | ✅ 実装済み (2026-06-11) |
| B-1 | 指示→ゴール正規化の標準パス化 | ◎ | 中 | **P1** | |
| A-7 | ファイル・画像の双方向転送 | ○ | 中 | P2 | |
| A-8 | チャネル別 trust プロファイル | ○ | 小 | P2 | |
| A-9 | ジョブ投入型運用 | ◎ (長期) | 中 (A群依存) | P2 | |
| B-2 | メモリの能動活用 | △ | 小 | P2 | |
| B-3 | checkpoint × チャネル | △ | 中 | P3 | |

実装順の推奨: **A-1 → A-2 + A-3（同一基盤）→ A-6 → A-4 → A-5 → B-1** → P2 群。
A-1〜A-3 と A-6 までで「チャネルから書き込みタスクを任せ、確認に答え、報告を受け取る」という
最小の自律運用ループが閉じる。

## 6. リスクと注意事項

- **認可**: チャネル経由の権限確認・コマンド受付は user ID allowlist を必須とする。
  Discord は署名検証済み（実装済）だが、「誰が許可ボタンを押せるか」は別の認可レイヤ
- **rate limit**: Slack ≈1msg/秒/チャンネル、Discord ≈5msg/5秒。A-4 はスロットリング必須
- **秘匿情報**: 進捗・完了報告にファイル内容やコマンド出力を生で流さない（パス+要約原則を踏襲）
- **既存原則との整合**: 捏造禁止・silent 欠損禁止・全量注入の方針はチャネル報告でも維持する
- 各項目の着手時は本書とは別に個別設計書を docs/ 配下に作成する（プロジェクトルール準拠）

## 7. 参考: 比較対象アプリの位置づけ（2026-01 時点の知識に基づく）

| アプリ | 特徴 | 本アプリとの差分 |
|--------|------|------------------|
| Claude Code | 強モデル前提の最高水準ハーネス。skills/hooks/MCP/sandbox | チャネル統合なし。ローカルLLM適応なし |
| OpenHands | ブラウザUI、サンドボックスVM、強モデル前提 | 弱モデル補強なし。常駐チャネル運用なし |
| Aider | git 統合と edit format 工夫が秀逸 | エージェントループ・ツール生態系が狭い |
| Goose | 拡張機構 (MCP) 中心の OSS エージェント | ローカルLLM向けハーネス工学は薄い |
| OpenClaw 系 | チャネル常駐アシスタント特化 | 開発エージェントとしてのツール・権限・検証基盤が薄い |
| AutoGPT 系 | 自律ループの先駆 | 検証可能ゴール・hard gate がなく発散しやすい |

本アプリの固有ポジション: **「ローカルLLMで実用になる開発エージェント」×「チャネル常駐の
自律運用」の交点**。前者は既に強く、後者を本提案で埋めるのが最短の差別化路線。
