# 完了報告の構造化と proactive 通知 設計書 (A-6)

作成日: 2026-06-11
対応提案: docs/autonomy-improvement-proposal.md §4.1 A-6
前提: docs/agent-events-design.md (A-1) の task_complete イベント
ステータス: 実装済み

## 1. 背景と目的

- チャネル (Slack/Discord) の応答は本文のみで、何が行われたか（変更ファイル・コスト・所要時間）が
  伝わらなかった
- CLI の webhook 通知（旧実装）は「最後の assistant メッセージをそのまま送る」だけで、
  履歴スキャンの重複実装 + outcome（中断/エラー）が伝わらない問題があった

**「任せて、あとで報告を受け取る」運用のため、task_complete イベントから構造化レポートを
組み立てて、チャネル応答のフッターと webhook 通知に使う。**

## 2. task_complete ペイロードの拡張

| 追加フィールド | 内容 |
|----------------|------|
| `filesChanged: string[]` | run 内で file_write / file_edit が成功したパス（重複なし） |
| `tokensIn / tokensOut: number` | run 累計トークン（provider が usage を報告した分） |
| `costUsd: number` | run 累計の推定コスト（単価未登録モデルは 0） |

収集は AgentLoop の runStats で行う（usage ハンドラとツール実行の両ルート）。

## 3. task-reporter (`src/agent/task-reporter.ts`)

- `formatStatsLine(e)` — `⏱ 2分34秒 · 🔧 12 tools · 📝 3 files · 🪙 in 12.3K/out 4.5K ($0.0123)`
- `formatReportFooter(e)` — チャネル応答用のコンパクトフッター。
  **ツール 0 回かつ completed なら null**（会話的応答にノイズを付けない）。
  outcome が completed 以外なら明示（捏造禁止: 中断/エラーを完了と偽らない）
- `formatTaskReport(e)` — webhook 通知用。outcome + 最終応答（800字まで）+ 統計 + 変更ファイル
  （10 件まで）。**ファイル内容・コマンド出力は載せない**（パス + 要約原則）

## 4. 利用箇所

| 箇所 | 内容 |
|------|------|
| SlackBot / DiscordInteractionServer | 最終応答の末尾に `formatReportFooter` を付加 |
| repl.ts (CLI) | 旧「最後の assistant メッセージを送る」通知を `formatTaskReport` に置換。task_complete 購読に統一し履歴スキャンを廃止 |

## 5. 通知ゲート (config)

```json
{ "notifications": { "minDurationSec": 60 } }
```

- `minDurationSec` 未満で完了したタスクは webhook 通知をスキップ（デフォルト 0 = 従来どおり毎回）
- 「長時間タスクの完了だけ知りたい」ユースケース向け。discord/slack の `enabled` ゲートは従来どおり

## 6. 既知の制約・後続課題

- Discord の最終応答は @original の PATCH のため、複数チャンクが同一メッセージを上書きする
  既存問題が残る（A-4 の follow-up 化で解消予定）
- サブエージェント・セカンド LLM のコストは runStats に含まれない（main スロットのみ）。
  全体コストは `/cost` を参照
