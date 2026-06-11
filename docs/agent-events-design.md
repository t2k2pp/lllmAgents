# AgentLoop イベント化 (AgentEventBus) 設計書

作成日: 2026-06-11
対応提案: docs/autonomy-improvement-proposal.md §4.1 A-1
ステータス: Phase 1 実装済み

## 1. 背景と目的

AgentLoop は console 出力 (console.log / process.stdout / ora スピナー、約55箇所) と密結合しており、
Discord / Slack アダプタは「run() 完了後に履歴から最後の assistant メッセージを掘り出す」しかなかった。
このままでは A-2（チャネル権限確認）、A-4（進捗中間報告）、A-6（完了報告の構造化）をチャネルごとの
分岐として agent-loop に増殖させることになる。

**設計思想: 「何が起きたか (イベント)」と「どう見せるか (レンダリング)」を分離し、
チャネルを「もう一つのフロントエンド」にする。**

```
AgentLoop ──emit──> AgentEventBus ──> CliRenderer   (Phase 2 で移設)
                                  ──> SlackBot      (購読: Phase 1 で対応済み)
                                  ──> DiscordInteractionServer (同上)
                                  ──> (将来) JobRunner / 通知系 (A-6, A-9)
```

## 2. スコープ（段階移行）

| Phase | 内容 | 状態 |
|-------|------|------|
| 1 (本書) | AgentEventBus 新設、AgentLoop からの発火、Slack/Discord アダプタのイベント購読化 | 実装済み |
| 2 (A-4 と同時) | CLI レンダリング（スピナー含む）の購読者への移設、進捗イベントの粒度拡充 | 未着手 |
| 3 (A-2/A-3) | Promise 返却型の対話ブリッジ（権限確認 / ask_user）の接続 | 型定義のみ |

Phase 1 で CLI 表示を移設しない理由: ora スピナーのライフサイクル（待機→考え中→受信中→ツール実行）が
run() 内のローカル制御フローと密結合しており、一括移設は回帰リスクが高い。Phase 1 では
**既存 CLI 表示を一切変えず**、同じ地点からイベントを併発する（CLI に購読者はいないため二重表示はない）。

## 3. イベント定義

`src/agent/agent-events.ts` の `AgentEventMap` が正本。

| イベント | ペイロード | 発火タイミング |
|----------|-----------|----------------|
| `task_start` | source, prompt, timestamp | run() 開始時 |
| `assistant_text` | text (think タグ除去済み), final | アシスタントテキスト確定時。final=true はユーザー向け最終応答、false は中間ナレーション（CLI の白/灰色表示に対応） |
| `tool_start` | callId, name, summary | ツール実行直前（単発・並列両ルート） |
| `tool_end` | callId, name, summary, success, durationMs, error? | ツール実行完了時 |
| `harness_notice` | level (info/warn/error), message | ハーネス介入・診断の主要通知（自己点検、接続リトライ、ソフトキャップ、stuck-loop 等） |
| `task_complete` | source, outcome, finalResponse, iterations, durationMs, toolsExecuted | run() 終了時（finally で必ず発火） |

### 3.1 outcome の決定

span 終了点はすべて `purgeEphemeralAtSpanEnd(reason)` を通る（中断の一部を除く）ため、
reason → outcome のマッピングをそこで行い、finally で読む:

| purge reason | outcome |
|--------------|---------|
| response_complete, final_text_response, self_check_limit | completed |
| user_abort, llm_error_abort, tool_abort, synthetic_write_abort | aborted |
| garbage_response, empty_response_giveup, llm_call_unsuccessful | error |
| max_iterations | max_iterations |
| （上記以外 / 未設定） | incomplete（finally 時点で _aborted なら aborted） |

注: self_check_limit は「自己点検上限に達したが応答は返した」状態で、ユーザー視点では応答完了。
未完了 ToDo の有無は finalResponse / harness_notice 側で伝わる。

### 3.2 finalResponse

- `response_complete` 経路: summary（非空時）
- `final_text_response` 経路: think タグ除去済みの最終テキスト
- error / aborted 系: 空文字列（チャネル側がフォールバック文言を出す）

これにより Slack/Discord アダプタの「履歴を逆順スキャンして think タグを剥がす」重複実装を廃止。

## 4. AgentEventBus の仕様

- 型付き `on(event, listener)` / `emit(event, payload)`。`on` は解除関数を返す
- **リスナー例外の隔離**: 購読者の throw は logger.debug に落とし、AgentLoop 本体には伝播させない
  （チャネル側の障害でエージェントを止めない）
- 同期 dispatch（リスナーが async の場合は fire-and-forget。順序保証が必要な処理は購読側で直列化）
- EventEmitter (node:events) を使わない理由: 型安全、依存最小、`error` イベントの暗黙 throw 仕様の回避

### 4.1 Phase 3 への seam（型定義のみ・未接続）

A-2/A-3 用に Promise 返却型のハンドラ型を定義しておく:

```ts
interface InteractionBridge {
  requestPermission?(req: PermissionRequest): Promise<PermissionDecision>;
  askUser?(req: AskUserRequest): Promise<AskUserResponse>;
}
```

イベント（通知・一方向）と対話（要求・応答）は別の機構として扱う。対話はタイムアウト付き
Promise で、未設定時は従来の headless 動作（拒否 / ツール非公開）にフォールバックする。
接続は A-2/A-3 の個別設計書で行う。

## 5. 変更ファイル

| ファイル | 変更 |
|----------|------|
| `src/agent/agent-events.ts` | 新規。イベント型・AgentEventBus・InteractionBridge 型 |
| `src/agent/agent-loop.ts` | `events` フィールド追加、各発火点の併設、run 統計 (outcome/finalText/toolsExecuted) |
| `src/slack/slack-bot.ts` | `task_complete` 購読で最終応答を取得（履歴スキャン廃止） |
| `src/discord/interaction-server.ts` | 同上 |
| `tests/agent/agent-events.test.ts` | 新規。bus の単体テスト |

## 6. 非目標（Phase 1 ではやらない）

- CLI 表示のイベント購読化（Phase 2）
- ストリーミングチャンク粒度のイベント（チャネルの rate limit 上、確定テキスト単位で十分。
  必要になれば A-4 で `assistant_text_chunk` を追加）
- harness_notice の全 console 出力網羅（主要通知のみ。網羅は Phase 2 の表示移設と同時に行う）
- サブエージェント / second LLM のイベント中継（メインループのみ。委任側は tool_start/end で見える）

## 7. リスク

- 発火点の漏れ: task_complete は finally で保証。assistant_text は flushAssistantText に集約し、
  ストリーミングモードでも（表示はライブ済みでも）イベントは発火するよう一本化した
- 購読者のメモリリーク: `on` の解除関数を必ず finally で呼ぶ（アダプタ実装の規約）
