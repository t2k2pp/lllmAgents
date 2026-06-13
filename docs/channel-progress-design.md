# チャネル進捗中間報告 設計書 (A-4)

作成日: 2026-06-11
対応提案: docs/autonomy-improvement-proposal.md §4.1 A-4
前提: docs/agent-events-design.md (A-1) のイベント
ステータス: 実装済み

## 1. 背景と目的

チャネル経由の長時間タスクは「処理中...」の 1 メッセージのまま完了まで沈黙し、
生死が判断できなかった。**1 つの進捗メッセージを編集し続ける方式**で、ツール実行の
流れをリアルタイムに可視化する（新規メッセージを連投しない = 通知スパム防止）。

## 2. ChannelProgressTracker (`src/agent/channel-progress.ts`)

AgentEventBus を購読してチャネル非依存に進捗テキストを組み立て、
チャネル固有の「メッセージ編集関数」を呼ぶ。

```
ChannelProgressTracker(update: (text) => Promise, minIntervalMs = 5000)
  .attach(agentLoop.events)   // tool_start / tool_end / harness_notice を購読
  .detach()                   // 完了時に解除 (以後の編集を止める)
```

### 表示内容（例）

```
⏳ 処理中... (1分23秒 · 🔧 7 tools)
✓ file_read src/index.ts
✗ bash npm test: exit 1
✓ file_edit src/index.ts
▶ bash npm run build
```

- 完了したツール直近 5 件（✓/✗）+ 実行中ツール（▶）+ 経過時間・累計ツール数
- harness_notice の warn/error も行として混ぜる（自己点検 info はノイズのため除外）
- 各行 80 字で切り詰め。ファイル内容・コマンド出力は載せない（パス + 要約原則）

### スロットリング

- 編集は最小間隔 5 秒（Slack ≈1msg/秒、Discord webhook PATCH のレート制限対策）
- 間隔内のイベントは coalesce して 1 回の編集にまとめる（trailing edge で必ず最新状態を反映）
- 編集失敗は握りつぶす（進捗表示はベストエフォート。本処理に影響させない）

## 3. チャネル別の編集先

| チャネル | 進捗メッセージ | 完了時 |
|----------|----------------|--------|
| Slack | 「処理中...」メッセージを `chat.update` | 進捗メッセージを「outcome + 統計」に確定し、最終応答は別メッセージで投稿 |
| Discord | deferred 応答 (@original) を PATCH | 最終応答の第 1 チャンクが @original を上書き（進捗が回答に変わる）|

### Discord の複数チャンク修正（既存バグ）

旧実装は全チャンクを @original に PATCH しており、2 チャンク目以降が前を上書きしていた。
第 1 チャンクのみ @original、以降は新規 follow-up (POST) に修正。

## 3.5 ChannelResponseCollector — 最終応答の全文収集 (2026-06-13 追加)

チャネルの最終応答は当初 `task_complete.finalResponse` を使っていたが、これは
「span を終わらせた応答のテキスト」だけを持つ。本文を途中ターンで出し終え、
最終ターンが確認・要約だけになるパターン（自己点検リプロンプト後に
response_complete で締める等）では、**肝心の本文がチャネルに届かない**
事故が起きた（Discord /ask「自己紹介して」で要約のみ返った実例、2026-06-13）。

対策として `ChannelResponseCollector` を追加。run 中に emit された
`assistant_text` イベント（= CLI で白表示されるユーザー向けテキスト）を
全件収集し、発話順に `\n\n` で結合したものを最終応答とする。

- CLI とチャネルの情報量が一致する（no-silent-loss）
- 「どれが本文か」の意味分類はしない（構造ベース。coloring v2 と同じ思想）
- ツール実行前のナレーション（「では確認します」等）も含まれるが、CLI で
  見えるものと同じであり、欠落より冗長を選ぶ
- collector が空のときのみ finalResponse にフォールバック（保険）

## 4. テスト

`tests/agent/channel-progress.test.ts` — fake timers でスロットリング、coalesce、
detach 後の停止、表示内容（✓/✗/▶、件数）、ChannelResponseCollector の
収集・結合・detach 後の無視を検証。

## 5. 後続課題

- 確認待ち（権限ボタン表示中）であることの明示（「⏸ 確認待ち」行）
- ToDo 進捗（todo_write の中身）の表示は、todo イベント化（A-1 Phase 2）後に検討
