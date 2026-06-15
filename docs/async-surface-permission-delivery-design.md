# 非同期サーフェス（Discord/Slack）権限・配信・観測性 再設計

実装エージェント向けの作業仕様。状態: ドラフト・未実装（本書合意後に着手）。
再現/H-1切り分け用ログ: `~/.localllm/logs/sessions/2026-06-14T00-18-05_main.jsonl` / セッション `mqci53z7-cg4k.json`(room=B)。
関連: `room-model-design.md` `channel-interaction-bridge-design.md` `goal-seek-mode-design.md`。

## 確定原因 → 直す場所

**R-1 `source` が「最初に run を起こした発信元」に固定され、Room を跨いでも変えられない**
- `currentSource` は `run()` 入口でのみ設定・sticky: `agent-loop.ts:462`。権限はこれで分岐: `:1647`。
- `run()` は1回で `for(iteration<hardCap)` を回し、goal-seek も同 run() 内で継続: `:562, :1215-1223`。
- ⇒ Discord 発 goal-seek は source=discord 固定の長時間1本 run()。`/room B` では止まらず source も変わらない（REPL から救えない）。

**R-2 Discord 返信・権限ボタンが15分失効の interaction token に密結合**
- 返信は全経路 `/webhooks/{appId}/{interactionToken}`: `interaction-server.ts:542,562,584`（sendFollowUp/postFollowUp/進捗/分割）。
- Bot Token は存在し Gateway で使用済み: `gateway-client.ts:178` / `interaction-server.ts:92-97`（`channels/{id}/messages` 未使用）。
- 未許可ツールは bridge ボタン確認へ: `permission-manager.ts:285`（自動許可セット: `:274-282, :120-121`）。

**R-3 stuck-loop は検出のみで遮断しない**: `agent-loop.ts:1885-1887`（console.log+notice のみ、break 無し。`recentFailures`:`:240`）。

**R-4 ログがプロセス単位で Room/surface タグ無し**
- `sessionId` はプロセス起動1回・`agentId="main"`: `index.ts:409,434`。命名 `<sessionId>_<agentId>.jsonl`。
- 一方セッションは `meta.room` で Room 別: `session-manager.ts`。記録粒度が割れている。

**R-5 大容量成果物の配達手段と「配達結果のフィードバック」が無い → モデルが偽完了**
- Discord 分割はあるが失効トークンで全 401: `interaction-server.ts:284`。REPL は端末に出るが生成打切で未完。

## 直す方向（各 R に対応）

- **5.1 (R-1)** 単一 sticky `currentSource` を廃し、権限/配信の解決時に「この run の実行コンテキスト（Room/面/ポリシー）」を都度引く。→ 決定1。
- **5.2 (R-2 配信)** 返信を Bot Token `channels/{channelId}/messages` に統一。3秒 defer ack は維持（`interaction-server.ts:201-202`）。進捗はメッセージ PATCH。→ 決定4。
- **5.3 (R-2 権限)** 背景面は同期確認を廃し Room 単位の事前承認ポリシー。未許可操作はブロック待ちでなく「正直に中断・報告」。サンドボックス/deny は維持。→ 決定2,3。
- **5.4 (R-3)** 同一(tool,error)が `FAILURE_WINDOW` 反復で run を打ち切り原因つきで報告。恒久失敗（401/認証/権限）は早期 abort。
- **5.5 (R-4)** 各 jsonl レコードに `roomId`/`surface` を付与（5.1 と同じ情報源）。
- **5.6 (R-5)** 配達をサーフェス能力で選択（添付優先→分割）。実配達結果（成功/失効/切捨）をツール結果でモデルへ返す。

## 未実証（対策禁止・先に切り分け）

**H-1** turn-1 で「おはよう」に `game_smoke` PASS を捏造（thinking が架空の前スナップショットを主張、履歴は msgs=2）。
層候補: vLLM prefix cache 跨ぎ漏れ / distill prior / 巨大 system プロンプト priming。
切り分け: クリーンで `[system,"おはよう"]` 直 curl ×N / prefix cache ON-OFF / system 中立化で再現比較。層を確定してから対策する。

## 実装順

実装状況（2026-06-16）:
- **P1 `5.5` ログタグ = 済**（`llm-logger.ts` LogContext/setContext、`agent-loop.ts` で roomId=session.meta.room / surface=currentSource を注入。A/B/C・cli/discord/slack に分岐なし。`tests/agent/llm-logger.test.ts`）。
- **P2 `5.2` Bot Token 配信 = 済**（`interaction-server.ts` postChannelMessage で channels/{id}/messages 送信。3秒 defer ack 維持＋@original 固定 ack。Slack は元々 bot token 配信で対象外）。
- **P3 `5.3` 権限ポリシー = 済**（`permission-manager.ts` 背景面 autorun。SecurityConfig.discord/slackAutorun 既定 true。deny/サンドボックス/危険block 通過を根拠に自動許可、doomed ボタン廃止。autorun 無効時のみ従来ブリッジ）。
- **P4 `5.4` stuck-loop 遮断 = 済**（`agent-loop.ts` _circuitBreak。恒久失敗(401/認証/権限)=2回目、一過性=5回で run 打ち切り＋正直報告）。
- **P5 `5.1` 実行コンテキスト化 = 案B採用により実質充足**（権限は checkToolPermission が currentSource を毎回読む／ログは P1 が決定時に読む＝決定時点で実行コンテキストを引いている。doomed ループは P3/P4 で消滅。案A 専用の「走行中 run の live re-source」は対象外＝未実装）。
- **P6 `5.6` 配達抽象 = 一部済**（大容量応答をファイル添付で配達＝済。「配達結果を run に feedback するループ」は P2 で配達が確実に成功するようになったため優先度低＝未実装）。
- 別トラック H-1（turn-1 confabulation の層切り分け）= 未着手（実証が要るため実装と独立）。

## 決定が要る（実装ブロッカー）

1. 走行中 run() を REPL が救出できるようにするか。案A=実行中 run の配達先/権限を差し替え可 / 案B=触らず明示中断→REPL source で再開。
2. 背景面 auto-approve の既定範囲（`file_write`/`bash` をサンドボックス内限定で許可する等）。
3. 「恒久失敗」判定（401/認証/権限恒久を即 abort 対象に含めるか）。
4. 進捗表示をメッセージ PATCH 更新にするか追記型にするか。

## テスト

token 失効後(>15分)でも Bot 経由で長文到達 / 背景面の未許可が無音401でなくポリシー判定 or 中断 / 同一エラー連続で abort / jsonl に roomId・surface / 実機 Discord は手動（パイプ不可）。
