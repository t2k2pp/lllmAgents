# Room モデル設計書

## 0. ステータス
- 状態: **ドラフト（レビュー待ち）**
- 起票: 2026-06-13
- 関連: `docs/channel-session-queue-design.md`(A-5), `docs/todo-goal-lifecycle.md`, `src/agent/session-manager.ts`, `src/agent/channel-sessions.ts`

## 1. 背景・目的
REPL / Discord / Slack はそれぞれ別の会話コンテキストを持つ（A-5）。しかし現状:
- チャンネル会話は **揮発 `ConversationStore`（in-memory）** にしか無く、PC 側プロセス再起動で消える。
- 永続化されるのは REPL の単一セッション（`agent.session` → `~/.localllm/sessions/<id>.json`）のみ。
- そのため「Discord でやっていた作業」は PC 再起動で失われ、リモートが PC の生死に依存する。

**目的**: コンテキストを「**Room**」という名前付き永続スロットに格上げし、サーフェスをまたいだ作業継続と、PC 再起動に強いリモート運用を実現する。

## 2. 用語
- **Room**: 名前付き（A/B/C）の永続的な会話スロット。中身は会話履歴・ToDo・Goal・mode（= `ConversationState`）＋ Room 設定。
- **サーフェス**: 入力面。REPL / Discord / Slack の 3 つ。
- **アクティブ Room**: あるサーフェスが「今しゃべっている」Room。

## 3. 現状分析（実装事実）
- `ConversationState = { history, todos, goal, mode }`（`agent-loop.ts:83`）。会話・ToDo・Goal は**すべてコンテキスト単位**で、`exportConversation()`/`importConversation()` が module singleton（`todo-write.ts` の `let todos` 等）を swap する（`agent-loop.ts:2552`,`2567`）。→ 分離は会話だけでなく ToDo/Goal も一貫している。
- `ConversationStore`（`channel-sessions.ts`）: `key → ConversationState` の in-memory LRU（最大20・**再起動で消える**）。Discord=`discord:<channelId>` / Slack=`slack:<channel>:<thread>`。
- 永続化: `SessionData = { meta, messages, todos?, goal? }` を `saveSession/loadSession/listSessions`（`session-manager.ts`）。`agent.saveCurrentSession()` は **REPL の `agent.session` のみ**保存。
- 起動時 resume: REPL は `--resume <id>` / `--continue`。デフォルトは新規セッション。

## 4. Room モデル仕様（確定）
1. **固定 3 Room: A / B / C**（作成・削除・増減は不要）。
2. **デフォルト割り当て**: REPL→A、Discord→B、Slack→C。**変更可・途中移動可**。
3. **自動 Resume 設定を Room ごとに持つ**:
   - Discord(B) / Slack(C) = **自動 Resume ON**（接続時にその Room の最後の会話を復元）。
   - REPL(A) = 既存仕様どおり **起動ごとに新規セッション**（自動 Resume OFF）。必要なら手動 Resume。
   - どの Room でも手動 Resume 可。
4. **永続化**: 各 Room のアクティブ会話を `SessionData` としてディスク保存。**ターンごとに保存**（既存 REPL と同じ粒度）。
5. **Room 識別**: 保存セッションに Room（A/B/C）を紐付け、一覧で RoomA/B/C と判別できる。

## 5. データモデル
**専用ファイル（rooms.json）は作らない。** 設定は `config.json`、Room↔セッションの紐付けはセッションファイル自身（`meta.room`）が持つ。理由は §10-4。
```ts
type RoomId = "A" | "B" | "C";

// config.json に追加（純粋な設定。滅多に変わらない）
interface RoomConfig {
  bindings: { repl: RoomId; discord: RoomId; slack: RoomId }; // 既定 A/B/C
  autoResume: Record<RoomId, boolean>;                         // B/C=true, A=false
}
```
- セッション側: `SessionMeta` に **`room?: RoomId`** を追加（後方互換: 旧ファイルは undefined）。
- **currentSessionId は保存しない**。Room X の最後の会話は「`meta.room===X` のうち最終更新（updatedAt 最大）のセッション」として `listSessions()` から導出する。Room↔セッションの正は常にセッションファイル側にあり、config と二重管理しない。

## 6. RoomManager（新規 `src/agent/room-manager.ts`）
責務: Room 設定（config 経由）の読み書き、Room ↔ `ConversationState` のロード/保存、サーフェスのアクティブ Room 追跡。
```
- getBinding(surface): RoomId                      // config.roomConfig.bindings
- setBinding(surface, roomId): 移動。現アクティブ会話を保存してから差し替え（config 更新）
- latestSessionOf(roomId): SessionMeta | null      // meta.room===roomId で updatedAt 最大
- loadRoomState(roomId): ConversationState | null  // latestSessionOf を loadSession → ConversationState 化
- saveRoomState(roomId, state, sessionId): SessionData 化(meta.room=roomId)して saveSession
- startNewInRoom(roomId): 新規 SessionData(meta.room=roomId) を作る
- autoResume(roomId): boolean
```
- `SessionData ⇆ ConversationState` の変換ヘルパ（messages⇄MessageHistory, todos, goal, mode）。mode は SessionData に新フィールド追加 or messages とは別管理（要検討、§10-3）。

## 7. 各サーフェスの挙動
- **REPL 起動**: binding.repl(=A) を見る。A.autoResume=false なら**新規セッション**（現行どおり）。`--resume/--continue` は当該 Room に対する手動 resume として解釈。
- **Discord 受信開始**: binding.discord(=B)。B.autoResume=true なら B.currentSessionId をロードして継続。なければ新規。
- **Slack 同様**（C）。
- **メッセージ処理**: 現行の swap（export 退避 → import → run → export 保存 → import 復帰）を、**ConversationStore ではなく RoomManager 経由**に置換。処理後は `saveRoomState` でディスク保存。
- **移動**: あるサーフェスで `/room B` → 現アクティブ Room を保存し、binding.<surface> を B に変更、B の会話をロード。以降そのサーフェスの入出力は B に乗る（＝ B を覗き見／継続）。

## 8. コマンド（既存方針: Discord/Slack は `/ask` テキスト内の先頭 `/`）
- `/room` … 現在の Room と 3 Room の状態（A/B/C、autoResume、メッセージ数）を表示。
- `/room <A|B|C>` … そのサーフェスを指定 Room へ移動。
- `/room resume [A|B|C]` … 手動 Resume（指定 Room の最後の会話を再ロード）。
- `/room autoresume <on|off>` … 現 Room の自動 Resume 設定。
- 既存の **`/clear` `/context` `/status` `/todo` は「現在の Room」に作用**（別コマンドを作らない＝意味は全サーフェス共通）。`/status` に現在 Room（A/B/C）と autoResume を表示。

## 9. 既存コードへの変更点（影響範囲）
- 新規: `src/agent/room-manager.ts`。専用ファイルは作らず設定は `config.json`（`config/types.ts` に `roomConfig` 追加）。
- `session-manager.ts`: `SessionMeta.room?` 追加、`SessionData.mode?` 追加。一覧表示に Room 反映。`listSessions` を Room フィルタ可能に。
- `channel-sessions.ts`: `ConversationStore` を RoomManager 参照へ置換（Discord/Slack の per-channel キーは廃止 or Room へ集約）。
- `interaction-server.ts` / `slack-bot.ts`: swap 先を RoomManager に。受信開始時の auto-resume。
- `repl.ts`: 起動時の Room A バインド、`/room` コマンド追加（completer/help/README の 4 点セット）、`/clear`/`/status` の Room 対応表示。
- `index.ts`: 起動時に RoomManager 初期化。

## 10. 未決事項（レビューで確認したい）
1. **複数サーフェスが同一 Room を指す場合の同時実行**: 例 REPL と Discord が両方 A。`ChannelRunQueue` は各サーフェス内直列だがサーフェス間は別。同一 Room への同時 run をどう直列化するか（Room 単位のロック導入が素直）。
2. **Discord の複数チャンネル**（解決済み）: 全チャンネル → Room B 集約で確定。別チャンネルの発話が同じ B に混ざるのは許容。チャンネル毎 Room は将来拡張（2026-06-13 ユーザー合意）。
3. **mode の永続化**: `SessionData.mode?` を追加して保存（解決済み・採用）。goal-seek 中の Room を保存/復元するため。
4. **設定の置き場所**（解決済み）: 専用 rooms.json は**作らない**。bindings / autoResume は `config.json`、currentSessionId は保存せず `meta.room` から導出。理由: currentSessionId はターン毎には変わらず低頻度、かつ Room↔セッションの紐付けはセッション側が正本。二重管理・ファイル分散を避ける（2026-06-13 ユーザー合意）。

## 11. 段階実装計画（初回スコープ = コア）
- **Phase 1（今回・コア）**: RoomManager + 3 Room 固定 + サーフェス既定バインド + ディスク永続化（ターン毎保存）+ `/room`（表示・移動・手動 resume）+ B/C 自動 Resume + セッションへの Room タグ。`/clear`/`/status` の Room 対応。
- **Phase 2（次回以降）**: `/room autoresume` 等の設定 UI 充実、同一 Room 同時実行ロック（§10-1）、`/context`/`/todo` の Discord 返却整備、移行（既存 volatile 会話の扱い）。

## 12. テスト方針
- RoomManager の単体テスト（load/save/move/resume、後方互換 = room 無しセッション）。
- 永続化の round-trip（ConversationState ⇆ SessionData）。
- TTY 対話・Discord/Slack 実機は手動検証（パイプ不可）。
