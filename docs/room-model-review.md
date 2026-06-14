# Room モデル実装レビュー (c1fc5be..3c7fedd)

- 対象コミット: `8f46f6d` `42f931e` `e6001fc` `d657803` `ae695c1` `e67edc5`(Phase1) `57ec6c3`(Phase1.5) `3c7fedd`(Phase2)
- レビュー日: 2026-06-14 / レビュアー: Claude (Opus 4.8)
- 修正反映: 2026-06-14（H-1 / M-1 / M-2 / M-3 / L-1 / L-4 を対応。 §修正対応サマリ 参照）
- 設計書: `docs/room-model-design.md`
- 前提: 本変更はバイブコーディングで素早く作られたもの。 動作する happy path は確認済みだが、
  **並行実行・状態境界・周辺 UX に複数の課題**がある。 以下、 重大度順。

---

## H-1 (重大・要修正) REPL のスラッシュコマンドが FIFO キューを迂回し、 背景ジョブ実行中に agent 状態を破壊する

設計の中核不変条件 (`room-manager.ts:12-17`, design §10-1):

> AgentLoop は単一インスタンス。 run 実行中にアクティブ Room を切り替えてはならない。 受信順
> グローバル FIFO キューが run を直列化している前提でアクティブ化する。

ところが **REPL のコマンド処理 (`handleCommand`) はキューを通っていない**。
`processInput`(通常メッセージ) は `roomQueue.enqueue(...)` 経由で直列化されるが、
`/clear` `/room` `/room resume` などは `repl.ts:328` の `handleCommand` から
**同期的に直接** `roomManager.moveSurface` / `activateRoom` / `agent.getHistory().clear()` を呼ぶ。

### 再現シナリオ (フォアグラウンド REPL + Discord 受信が同一プロセス)
`listenEnabled` 時は REPL 起動中に `startInteractionServer()` が走り、 Discord 受信が
同じ `roomQueue`・同じ `agent` を共有する (`repl.ts:266-268`)。

1. ユーザーは REPL プロンプトで `this.input.question()` を await 中 (`agentBusy=false`)。
2. Discord メッセージ着信 → キュー → `runInRoom("B")` → `activateRoom("B")` で agent は Room B を
   ロードし `agent.run()` 実行中。 await の合間にイベントループへ制御が戻る。
3. ユーザーが REPL で `/clear` または `/room C` を Enter → `question()` が解決 → `handleCommand` が
   **1 tick 内で同期的に** アクティブ Room の切り替え/clear を完了させ、 **実行中の Discord run の途中で**
   `saveCurrentSession()`(Room B の中途状態を保存) + `restoreSession()`(履歴差し替え) を行う。

### 影響
- **`/clear`**: 現在ロード中の Room (= 背景ジョブの Room B) の履歴・ToDo・Goal を消す。
  REPL の Room A を消す意図なのに B を消し、 さらに表示は `clearedRoom = roomManager.current()` =
  `B` なので「(Room B)」と出る (`repl.ts:3636`)。 実行中の Discord 会話が破壊される。
- **`/room C` (moveSurface)**: `activateRoom` が B の中途状態を保存し履歴を C に差し替え。
  Discord run はこの後 B のつもりで動き続け、 状態不整合・誤保存になる。
- **`/status` `/context` `/todo` (読み取り)**: 背景ジョブの Room B のデータを表示してしまう
  (REPL は Room A のつもり)。 破壊はしないが誤情報。

要するに「メッセージ run は直列化したが、 コマンド由来のアクティブ Room 切り替え/clear は直列化していない」。
キューに乗っているのは run だけで、 状態を触る経路がもう一本野放しになっている。

### 修正方針 (案)
- REPL のコマンドのうち **Room 状態に触れるもの** (`/clear` `/room` 移動/resume) を
  `roomQueue.enqueue(...)` に乗せる、 または背景ジョブ実行中 (`roomQueue.pending > 0`) は
  実行を遅延/拒否してユーザーに知らせる。
- 読み取り系 (`/status` 等) も「今 REPL がいる Room」を明示してから読む (アクティブ化して読む or
  REPL バインド Room のセッションを直接 load して表示) ようにする。
- Discord/Slack のチャネルコマンドは `runInRoom` 経由でキューに乗っているので問題ない。
  非対称なのは REPL 経路のみ。

---

## M-1 (中) `SessionData.mode` は宣言だけで未配線のデッドフィールド (設計書の記述と不一致)

`session-manager.ts` に `SessionData.mode?: AgentMode` を追加し、 design §10-3 は
「`SessionData.mode?` を追加して保存 (解決済み・採用)」と書いている。 しかし実際には:

- `saveCurrentSession()` (`agent-loop.ts:2378`) は messages/todos/goal を書くが
  **`this.session.mode` を一切セットしない** → 永続化されない。
- `restoreSession()` (`agent-loop.ts:2518`) は **`sessionData.mode` を読まない**。 mode は
  `sessionData.goal` の有無から再導出している (`goal` あり → `goal-seek`, line 2555)。

`AgentMode = "forward" | "goal-seek"` で goal-seek は必ず goal slot を伴うため、 現状の
goal 推論で**たまたま等価**になり実害は出ていない。 が、 フィールドは書かれず読まれない
完全なデッドコードで、 設計書は「保存している」と過大記述している。

→ 配線する (save/restore で mode を授受) か、 フィールドと §10-3 の記述を削除して
「mode は goal の有無から導出する」と明記すべき。 「実装したつもりで実装されていない」典型。

---

## M-2 (中) REPL のメッセージがキュー待ちでも無フィードバック (Discord/Slack と非対称)

`processInput` のメッセージは `roomQueue.enqueue(...).result` を await するが、
背景ジョブが先に走っていると **何の表示もないまま停止**する (run が始まるまで spinner も出ない)。
Discord/Slack は `position > 0` で「N 番目に追加しました」を返す (`interaction-server.ts`,
`slack-bot.ts`)。 REPL だけ待機フィードバックが無く、 ユーザーには「固まった」ように見える。

→ REPL でも `enqueue` の `position > 0` 時に「他サーフェスのジョブ待ち N 件」を表示する。

---

## M-3 (中) type-ahead 中にエスケープシーケンス (矢印キー等) を打つと入力中の行が消える

`startTypeAhead` (`repl.ts:3556-3565`):

```js
if (b === 0x1b || b === 0x03) { bytes = []; return; } // ESC / Ctrl+C
```

raw mode では矢印キー・Home・End・Delete などはすべて `0x1b` 始まりのシーケンスで届く。
この分岐は **入力中バッファ全消し + そのチャンクの残りも捨てる**。 つまり run 中に打鍵を
溜めている最中に矢印キーを 1 回押すと、 それまで打った内容が**無言で全部消える** (echo も
無いので気づけない)。 interrupt-watcher 側は ESC+seq を「中断しない」と正しく無視するのに、
type-ahead 側は破棄してしまい挙動が噛み合っていない。

→ ESC 単独 (中断) と ESC+シーケンス (矢印等) を interrupt-watcher と同様に区別し、
シーケンスは type-ahead バッファを保持したまま読み飛ばす。

---

## L-1 (小) type-ahead の backspace がマルチバイトを 1 バイトだけ削る

`if (b === 0x7f || b === 0x08) { bytes.pop(); }` (`repl.ts:3568`)。 日本語等 (UTF-8 3 バイト)
を type-ahead 中に backspace すると 1 バイトだけ pop してバッファが壊れる。 echo が無いため
不可視のエッジケースだが、 確定時に文字化けした行がキューに入る。

---

## L-2 (小) `runInRoom` の冗長なディスク書き込み / 読み取り専用コマンドでも更新時刻が動く

`runInRoom` は活性化時 (`activateRoom` が resting を save) → fn 後に `saveCurrentSession()` →
finally で resting へ戻す (再び save) と、 1 ジョブで同じ Room を 2〜3 回保存する。 さらに
**読み取り専用のチャネルコマンド (`/status` `/context` `/todo`) でも** `runInRoom` 経由で
アクティブ化 + save が走り、 変更が無いのに対象 Room のセッションファイルを書き換え、
`updatedAt` を更新する。 これは Room の「最後の会話」判定 (`latestSessionMetaOfRoom` =
updatedAt 最大) を読み取りコマンドだけで動かしてしまう副作用がある。 REPL 経路も
`runInRoom` の save と main ループ `repl.ts:339` の save で二重保存。

→ 読み取り系コマンドは `runInRoom` ではなく非破壊の参照経路にする。 save の重複も整理。

---

## L-3 (小) `status()` / アクティブ化のたびにセッションディレクトリ全走査

`status()` は Room ごとに `latestSessionMetaOfRoom` → `listSessions` で
**全 `.json` を read + JSON.parse** し、 active Room は別途 `loadSession` する。 1 回の
`status()` で最大 3 回の全走査。 背景メッセージごとの `resolveRoomSession` でも走査が走る。
ローカル小規模なら問題ないが O(セッション数) がコマンド毎・メッセージ毎にかかる。
セッションが増えると体感に出る。 簡易キャッシュ or インデックスを検討。

---

## L-4 (小) config ロード時に roomConfig 値を検証していない

`config-manager.ts` の `roomConfig` マージは `parsed.roomConfig?.bindings` をそのまま
取り込む。 手編集で `bindings.discord: "X"` のような不正値が入ると `bindingFor` がそのまま
`"X"` を返し下流で壊れる。 `room-types.ts` に `isRoomId` があるのに load では使われていない。

→ load 時に各 binding/autoResume キーを `isRoomId` で検証し、 不正なら既定へフォールバック。

---

## N-1 (注意) 入力系・終了系の投機的修正が TTY 実機未検証

この範囲には対話品質・終了挙動に関わる修正が含まれるが、 いずれもコミットメッセージで
「投機的・要検証」とされ、 手動 TTY 検証がまだ:

- `spinner.ts` — ora の `discardStdin:false` 化 (Windows 入力固着対策)。 ora の
  stdin-discarder の win32 非対称バグを正しく根本診断しており方針は妥当。 だが実機未確認。
- `http-client.ts` / `index.ts` — `/quit` 後にプロセスが終わらない件で undici keep-alive
  (`streamAgent` + global dispatcher) を明示破棄。 2 プールとも閉じており実装は妥当 (httpGet/
  httpPost=global, stream=streamAgent の両方をカバー)。 ただし `process.exit` 経路 (Ctrl+C×2,
  SIGTERM) は `shutdownHttpClient` を通らない (= 強制終了なのでハンドルは問題にならない、
  という整理は正しい)。 こちらも `/quit` 実機での終了確認が必要。

`lllmAgents/CLAUDE.md` の「対話品質に関わる変更後は手動 TTY 確認が必要」に従い、
H-1 修正と合わせて実機検証を 1 回通すべき。

---

## 良かった点
- 旧 `ConversationStore`/`ChannelRunQueue` (揮発・per-surface) を 1 本の受信順 FIFO に統合し、
  ロック不要で同一/別 Room を到着順に直列化する設計判断は筋が良い。
- `currentSessionId` を config に持たず `meta.room` から導出する「正本はセッション側」方針は
  二重管理を避けており妥当 (design §10-4)。
- `room-types.ts` を純粋型・定数だけに切り出し循環依存を避けた構成、 後方互換 (`room?`
  undefined) の配慮、 RoomManager/Queue の単体テスト整備は良い。

## 修正対応サマリ (2026-06-14)

| ID | 状態 | 対応内容 |
|----|------|----------|
| H-1 | ✅ 修正 | REPL の状態変更コマンド (`/clear` `/room` 移動 `/room resume`) を新ヘルパ `runRoomMutation` で受信順 FIFO キューに乗せ、 背景ジョブの完了を待ってから実行するよう直列化。 `/clear` は `runInRoom(REPL の Room)` 経由で必ず REPL の Room をアクティブ化してからクリアする (相手の会話を消さない)。 (`repl.ts`) |
| M-1 | ✅ 修正 | デッドフィールド `SessionData.mode` と `AgentMode` import を削除。 `restoreSession()` は goal の有無からモードを一意導出し、 goal が無ければ `forward` へ明示リセット (アクティブ化切り替え時の goal-seek 取り残しバグも解消)。 設計書 §10-3 を「永続化しない」に更新。 (`session-manager.ts` `agent-loop.ts` `room-model-design.md`) |
| M-2 | ✅ 修正 | REPL のメッセージがキュー待ちのとき `position>0` で「他サーフェスのジョブ N 件の完了を待っています」を表示 (Discord/Slack と対称)。 (`repl.ts`) |
| M-3 | ✅ 修正 | type-ahead で ESC/エスケープシーケンス受信時に蓄積バッファを消さず、 その chunk の残りのみ読み飛ばすよう変更 (矢印キーで入力中の行が消えるバグを解消)。 (`repl.ts`) |
| L-1 | ✅ 修正 | type-ahead の backspace を UTF-8 コードポイント単位の削除に変更 (マルチバイトを 1 バイトだけ削る破損を解消)。 (`repl.ts`) |
| L-4 | ✅ 修正 | `loadConfig` に `mergeRoomConfig` を追加し、 手編集による不正な binding 値 (`isRoomId`) / autoResume 値 (boolean) を既定へフォールバック。 (`config-manager.ts`) |
| L-2 | ⏸ 保留 | 読み取り専用チャネルコマンドでも `runInRoom` が save する件。 bump されるのは同一のアクティブセッションで「最後の会話」判定は変わらず、 実害は冗長なディスク書き込みのみ。 過剰な分岐を増やすリスクと釣り合わないため保留。 |
| L-3 | ⏸ 保留 | `status()`/swap のディレクトリ全走査。 ローカル小規模では問題にならず、 セッション数増大時にインデックス導入を再検討。 |
| N-1 | ⚠ 未検証 | spinner(`discardStdin:false`) / undici keep-alive 破棄は実装妥当だが TTY 実機・`/quit` 実機の手動検証が残る。 H-1 / M-3 / L-1 の入力系修正と合わせて 1 回通すこと。 |

検証: `npm run lint` (tsc --noEmit) クリーン。 `tests/agent/` `tests/config/` 全緑 (255 passed)。
RoomManager / RoomRunQueue / channel-commands の単体テストも緑 (17 passed)。
既存の失敗 4 件 (`process-sandbox` / `sandbox-proxy`) は Windows 環境のプラットフォーム依存で本変更と無関係。

## テストで未カバーの領域
- H-1 の「コマンド経路がキューを迂回する並行性」はコンポーネント横断のため既存単体テストでは
  検出できない。 RoomManager 単体・Queue 単体は happy path のみ。
- type-ahead (M-3/L-1) と spinner/http 終了 (N-1) は TTY/プロセス挙動依存で自動テスト困難 →
  手動検証チェックリスト化を推奨。
