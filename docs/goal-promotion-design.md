# 指示→ゴール正規化の標準パス化 設計書 (B-1)

作成日: 2026-06-12
対応提案: docs/autonomy-improvement-proposal.md §4.2 B-1
前提: docs/goal-seek-mode-design.md (Goal Seek mode / goal-slot)
ステータス: 実装済み

## 1. 背景と目的

「ユーザーの指示から意図・目的を理解して行動する」ための既存資産として Goal Seek mode
（検証可能な acceptance criteria + 反復評価 + response_complete ゲート）があるが、
突入経路が `/goal-seek` の明示コマンドのみで、通常の依頼パスでは使われなかった。

**B-1: 複雑なタスク依頼を検出したら、ハーネスが Goal Seek への昇格を「提案」し、
ユーザー承認をもって goal slot を設定する。** これにより「指示 → 意図の要約 →
検証可能ゴール」の正規化が標準フローに組み込まれる。

### 設計原則との整合

goal-seek-mode-design.md §2.2「切替は user 明示のみ。AI 自動判定は不可」は維持する。
本機能は**自動切替ではなく自動提案**であり、承認（CLI: confirm / チャネル: ボタン）が
user 明示にあたる。承認なしに mode が変わることはない。

## 2. 発動条件（すべて満たす場合のみ提案）

| 条件 | 判定 |
|------|------|
| 有効化 | `config.goalSeek.autoPropose`（デフォルト true）。`false` で完全停止 |
| mode | forward のみ（既に goal-seek 中は提案しない） |
| 複雑度 | `classifyTaskComplexity(input) === "complex"`（heuristic、LLM 不使用） |
| 意図 | `IntentClassifier.isObviousTask(input)`（heuristic のみ。曖昧なら提案しない = 保守的） |
| UI | CLI: TTY のみ（**非 TTY パイプモードでは提案しない** — 自動テストを妨げない）。チャネル: askUser ブリッジ登録時のみ |
| cooldown | 拒否後 10 分は再提案しない。同プロセスで 2 回拒否されたら以後提案しない |

## 3. フロー

```
通常入力 → [発動条件チェック] → criteria 抽出 (LLM, /goal-seek と共通ロジック)
  → 提示 + 承認 (CLI: confirm / チャネル: ボタン「Goal Seek で実行」「通常実行」)
  → 承認: agent.enterGoalSeek(goal) → そのまま agent.run(入力)  ※goal slot が注入される
  → 拒否: cooldown 記録 → 通常実行
  → 抽出失敗/タイムアウト: 黙って通常実行 (提案はベストエフォート、本処理を妨げない)
```

- criteria 抽出は `/goal-seek` コマンドのインライン実装を `extractAcceptanceCriteria()` として
  共通化し、両経路で同じ品質の criteria を得る（DRY）
- チャネルでは A-3 の askUser ブリッジを再利用（実装追加なし）。会話スワップ (A-5) の後・
  run の前に行うため、goal slot はスレッド会話に正しく紐づく

## 4. 変更ファイル

| ファイル | 変更 |
|----------|------|
| `src/agent/goal-promotion.ts` | 新規。発動判定 / criteria 抽出（共通化）/ 承認 / cooldown |
| `src/cli/repl.ts` | 通常入力パスで提案を呼ぶ。`/goal-seek` の抽出ロジックを共通関数へ置換 |
| `src/slack/slack-bot.ts` / `src/discord/interaction-server.ts` | run 前に提案を呼ぶ |
| `src/config/types.ts` | `goalSeek?: { autoPropose?: boolean }` |
| `tests/agent/goal-promotion.test.ts` | 発動条件 / 承認 / 拒否 cooldown / 抽出失敗 |

## 5. 非目標・後続課題

- simple/standard タスクへの適用（ノイズ > 効果。complex のみ）
- 意図の LLM 分類（レイテンシ増。heuristic で確信が持てる場合のみ提案する設計）
- goal の途中修正 UI（criteria の編集は再実行 = /exit-goal-seek → /goal-seek で代替）
