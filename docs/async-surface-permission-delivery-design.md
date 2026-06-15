# 非同期サーフェス（Discord/Slack）の権限・配信・観測性 再設計

## 0. ステータス
- 状態: **設計ドラフト（レビュー待ち・未実装）**
- 起票: 2026-06-15
- 種別: 根本原因の設計書。実装は本書合意後に Phase 分割で着手。
- 自己完結性について: 本書は **会話文脈が compress で失われても単体で実装継続できる**ことを目的に、
  動機となった障害の生ログ証拠・コード参照（file:line）・確定/未確定の区別をすべて本文に含める。
  「会話で説明したから」に依存しない。
- 関連既存設計: `docs/room-model-design.md`, `docs/channel-interaction-bridge-design.md`,
  `docs/channel-session-queue-design.md`, `docs/discord-gateway-design.md`, `docs/goal-seek-mode-design.md`
- 関連方針メモ: 対症療法を避け根本を直す / 原因特定が先・対策は後（[[feedback_no_workarounds]]）。

---

## 1. 背景・動機（何が起きたか）
2026-06-14、Discord（Room B）で「ゲームを作って」と依頼したセッションが **約14時間半、納品もせず停止もせず失敗し続けた**。
ユーザーは「ローカルLLMは遅いので投げて離席する」運用。実害が大きく、根本原因の特定と再設計が必要。

固定 3 Room モデル（A=REPL / B=Discord / C=Slack、`docs/room-model-design.md`）の上で、単一 `AgentLoop` を
borrow-run-return で各 Room に載せ替えて動かしている。本障害はこの構成と、Discord 連携の権限・配信方式の
噛み合わせから生じた。

---

## 2. 証拠（生ログ・端末。compress 後も参照できるよう本文に保全）

### 2.1 LLM I/O ログ
- ファイル: `~/.localllm/logs/sessions/2026-06-14T00-18-05_main.jsonl`（プロセス単位・全 113 レコード・turn 1〜42、
  UTC 00:21→ 翌 01:17、**全レコード `agentId="main"`**）。
- 対応セッションファイル: `~/.localllm/sessions/mqci53z7-cg4k.json`（`meta.room="B"`, messageCount=80, title「おはよう」）。
- 権限が要るツール（`file_write` / `bash` / `ask_user` / `federated_delegate`）が **全て同一エラーで失敗**:
  > `権限確認がタイムアウトまたは失敗しました (Discord follow-up failed: 401 {"message": "Invalid Webhook Token", "code": 50027})。 操作は実行されていません`
  - 自動許可ツール（`todo_*` / `sandbox_info` / `response_complete`）は成功。
  - 失敗は約16回 / 約11.5時間。`file_write` は同一パス `sandbox\dodge-rush.html` に7回など同一引数の再試行。
- **浪費**: 11 回の再試行が毎回 ~38KB の HTML 全文を `file_write` 引数として再生成（input ≈ 11k tokens/回）。
  合計 **119,556 output tokens / 330 分**（セッション総出力 127k の 94%）が doomed な呼び出しに消費。
  単一生成が 25〜37 分の例多数（生成長/タイムアウト上限が無い）。

### 2.2 turn 1 の捏造（別系統の問題）
- turn 1 のユーザー発言は **「おはよう」（4文字）だけ**、アプリ履歴は **msgs=2（system + user）の新規**。
- それに対しモデルは実在ツール `game_smoke` の **PASS 出力フォーマットを正確に再現**して「スモークテスト PASS」を出力。
- turn 1 の thinking: 「**前のスナップショットで、私は game_smoke スモークテストを実行し、結果を返しました**」。
  実際にはそんな履歴は無い（msgs=2）。→ アプリ層の文脈持ち越しではなく **serving/model 層の confabulation**。

### 2.3 PC 端末（REPL）出力 — 「source が発信元固定」の決定的証拠
ユーザーが PC で `/room B`（REPL を Room B へ）した後、端末に:
```
file_write(dodge-rush.html, 26.2KB)...[WARN] Channel permission bridge error (discord/file_write): 401 Invalid Webhook Token
BLOCKED: 権限確認がタイムアウトまたは失敗しました ...
⚠ stuck-loop 検出: file_write が直近10反復で同一エラー再発 (tier=T2)
```
- **REPL の端末で操作しているのに permission の source が `discord`**（`discord/file_write`）。TTY 確認は出ず、
  Discord ボタン配信に行き失効トークンで 401。
- `stuck-loop 検出` が出ても **ループは継続**（遮断していない）。
- 後続で REPL から「チャット欄にコードを出力してください」→ 応答は端末に出たが
  `(構造的不完全: 単語/文の途中で終端のため、続きを生成します...)` の通り **生成が途中で切れ**、
  その後モデルが「全文出力済み、スクロールして」と **完了を捏造**して終了。フルコードは端末でも得られず。

---

## 3. 確定した根本原因（コードで裏取り済み）

### R-1. `source` が「入力した面」でなく「最初に run を起こした発信元」に固定され、Room を跨いでも変えられない
- `AgentLoop.currentSource` は **`run()` 入口でのみ設定**され、以後 sticky（`src/agent/agent-loop.ts:462`
  `this.currentSource = options?.source ?? "cli"`）。
- 権限判定はこの `currentSource` を見る（`agent-loop.ts:1647` `if (currentSource === "discord" || "slack") → bridge`）。
- `run()` は **1回の呼び出しで `for (iteration < hardCap)` を回し**（`agent-loop.ts:562`）、goal-seek は同じ run() の中で
  評価→再試行を継続する（`agent-loop.ts:1215-1223`）。
- ⇒ **Discord 発の goal-seek は「source=discord に固定された1本の長時間 run()」**。これが何時間も file_write を撃ち、
  返ってこない。REPL の `/room B` は**バインド/表示を変えるだけで、走行中の run() を止めも source 付け替えもしない**。
  だから「REPL に入って手動承認で救う」が原理的に効かない（端末でも `discord/file_write` のまま 401）。

### R-2. Discord の返信・権限ボタンが全て「15分で失効する interaction webhook token」に密結合
- 返信は全経路で `/webhooks/{appId}/{interactionToken}/...` を使用（`src/discord/interaction-server.ts:542, 562, 584`）。
  `sendFollowUp`/`postFollowUp`/進捗 tracker/最終応答/分割チャンク すべて同じ token。
- interaction token は約15分で失効（`interaction-server.ts:23-24, 56-57, 234` に既知制約として明記）。
- ローカルLLMは1生成が15分を平気で超える（§2.1）。新規 interaction でも生成中に失効するため、
  `401 Invalid Webhook Token (code 50027)` が必発。
- **ところが Bot Token は存在し Gateway 接続で使用済み**（`src/discord/gateway-client.ts:178` `Authorization: Bot ${botToken}`,
  `interaction-server.ts:92-97`）。**失効しない `channels/{channelId}/messages` 送信が技術的に可能なのに使っていない。**
- 権限確認も同様: 自動許可（INHERENTLY_SAFE + `discordAutoApprove`/`slackAutoApprove` + セッション許可、
  `src/security/permission-manager.ts:274-282`）に無いツールは bridge のボタン確認に回り（`:285`）、
  そのボタンも interaction token 経由 → 401。`file_write`/`bash` は既定で auto セットに無いため必ずここに落ちる。

### R-3. stuck-loop は「検出するだけ」で遮断しない
- `agent-loop.ts:1885-1887`: 同一(tool,error) が `FAILURE_WINDOW` 反復で再発すると `console.log` 警告＋
  `notice("warn")` を出すのみ。**ループを break しない**。`recentFailures` は記録される（`:240`）が打ち切りに使われない。
- ⇒ 恒久エラー（401 は待っても直らない）でも上限 `hardCap`（`capability.maxIterations`）まで回り続ける。

### R-4. ログ（観測性）の粒度が Room モデルに追従していない
- LLM I/O ログのファイル名は `<sessionId>_<agentId>.jsonl`。`sessionId` は **プロセス起動時に1回**
  （`src/index.ts:409` `createSessionId()`）、`agentId` は固定 `"main"`（`src/index.ts:434`）。
- 単一 AgentLoop を全 Room/サーフェスで共有するため、**REPL/Discord(B)/Slack(C) が1ファイルに混在**し、
  各レコードに Room も surface も付かない。
- 一方 **セッションファイルは `meta.room` で Room 別**（`src/agent/session-manager.ts`）。
  ⇒ 記録の粒度が割れている。「この run は REPL か Discord か」がログから判別不能で、本障害も端末を見るまで確定できなかった。

### R-5. 大容量成果物の配達手段とその結果フィードバックが無い
- ファイル書き込みが封じられた時の代替「チャットに貼る」しか無く、配達結果（実際に何文字届いたか/失効で落ちたか）が
  **モデルにフィードバックされない**。Discord は分割実装あり（`interaction-server.ts:284` `splitMessage(... DISCORD_MAX_LENGTH)`）だが
  チャンクは失効トークンで全 401。REPL は端末に出るが生成打ち切りで未完。
  どちらも「届いたつもり」でモデルが完了を主張 → §2.2/§2.3 の偽完了。

---

## 4. 未確定の仮説（実証してから対策する。今は対策を出さない）
- **H-1（turn-1 confabulation の層）**: 「おはよう」で `game_smoke` PASS を捏造する原因。候補:
  (a) vLLM prefix caching がセッション跨ぎで KV を共有し直前の game セッションが漏れる、
  (b) distill 元モデルの prior、(c) 巨大共有システムプロンプトの priming。
  **切り分け手順**: クリーン状態で `[system, "おはよう"]` を直 curl で N 回 / prefix caching ON-OFF / system 中立化で
  再現を比較し、層を確定してからその層を直す。**プロンプトに打ち消し文を足す対症療法はしない。**
- **H-2（goal-seek 1本 run() の境界）**: §2.1 の 4.5h ギャップ等から、徹夜分が厳密に1本の run() か、自己点検注入
  （`[自己点検 N/2]` = harness の連続テキスト介入）で複数 run() に跨るかは未精査。R-1 の結論（source=discord 固定）は
  端末で実証済みなので変わらないが、stuck-loop 遮断や source 付け替えの実装ポイントを決める際に要確認。

---

## 5. 設計方針（根本層。各案を「輸送路/症状の差し替えに過ぎないか」で自己点検する）

### 5.1 source を「発信元 run 固定」から外す（R-1 の根本）
**問題の本質**: 権限・配信の経路選択が、実行コンテキスト（今この run を駆動している面・Room）ではなく
「最初に run を起こした誰か」に1回だけ焼き付く。長時間 run / Room 越境で破綻する。

**方向（根本）**: 権限・配信の宛先を **その時点の実行コンテキスト**から解決する。具体的には Room（A/B/C）に
「配達先サーフェスと権限ポリシー」を結びつけ、run の途中でも Room のバインドが変われば追従する。
`currentSource` という単一 sticky フィールドを廃し、権限/配信解決時に「この run はどの Room の・どのポリシーか」を
都度引く形へ。
- 自己点検: これは輸送路差し替えではなく、**経路選択の依存先を“発信者”から“実行コンテキスト”へ変える**根本変更。
- 派生論点: 走行中 run() の途中で Room を REPL が奪う（救出する）操作を許すか。許すなら「実行中 run の
  配達先/権限ポリシーを差し替える」契約が要る。許さないなら「REPL が Room B の goal-seek を中断して引き取る」
  明示操作（例: `/room B takeover`）を用意し、中断→REPL source で再開、とする。**どちらにするかは §8 の未決事項。**

### 5.2 Discord/Slack の配信を「失効トークン」から「失効しないチャンネル送信」へ（R-2 の根本）
**方向（根本）**: 受信は Gateway（Bot Token）、**返信も Bot Token の `channels/{channelId}/messages`** に統一。
interaction の 3 秒 ack（defer, type 5）は維持（`interaction-server.ts:201-202` 既存）。最終応答・進捗・分割チャンク・
権限ボタンを **Bot メッセージ**で送る。`channelId` は受信時に取得済み（`processPrompt` に渡っている）。
- 自己点検: 「Bot Token に替える」は一見輸送路差し替えだが、ここでは **15分で消える前提そのものを除去**する＝
  根本。token 失効という時限爆弾を構造から消す。
- 補足: 進捗の「同一メッセージ編集」は Bot メッセージ ID に対する PATCH で実現可能（webhook @original の代替）。

### 5.3 背景面の権限は「同期確認」をやめ「事前承認ポリシー」へ（R-2 の権限側根本 / Q2）
**問題の本質**: 人が15分以内に答えられない非同期面で、ツールごとの同期的承認をモデル化していること自体が誤り。
配信を Bot Token にしても「人が答えるまで run が詰まる/失敗する」前提は残る（＝5.2 だけでは半分）。

**方向（根本）**: 背景サーフェス（Discord/Slack、および「投げて離席」運用の Room）は **autorun / 事前承認ポリシー**で動かす。
- ポリシーは Room（またはチャネル）単位。`discordAutoApprove`/`slackAutoApprove` の仕組みは既存（`permission-manager.ts:120-121`）。
- 安全性: remote 起動の面で `file_write`/`bash` を無条件 auto にするのは危険。**サンドボックス制約（既存
  `checkChannelSandbox`）+ deny ルール（覆せない）+ Room 単位の許可セット**を前提に、許可範囲を Room ポリシーで定義。
- 同期確認が必要な操作が背景面で発生したら、**ブロックして待つのでなく「承認待ちとして記録し、その run はそこで
  正直に中断・報告」**（人が後で承認 → 再開、は §5.6/§8 の resumable と連動）。
- 自己点検: これは「ボタンの送り先を替える」対症ではなく、**非同期面に同期確認を持ち込まない**という前提の変更＝根本。

### 5.4 stuck-loop を「検出→遮断」へ（R-3）
**方向（根本）**: 同一(tool, errorパターン)が `FAILURE_WINDOW` 反復で再発したら、**その run を打ち切り**、
ユーザーへ「恒久エラーで中断した（原因・最後のエラー文言つき）」を正直に報告する（`feedback_no_silent_loss`/
`feedback_no_fabrication` と整合）。警告だけ出して回し続ける現状（`agent-loop.ts:1885`）を是正。
- 特に「待っても直らない」種別（権限恒久失敗・認証エラー等）は1回でも abort 寄りに。リトライが意味を持つのは
  一過性エラー（通信断等）だけ（[[feedback_no_fabrication]] の「粘り強いリトライは可、ただし恒久失敗は別」）。

### 5.5 観測性: 記録を Room/surface でタグ（R-4 / Q1）
**方向（根本）**: 「ログ＝jsonl＝セッションファイル」を **Room を単位として一貫**させる。最小実装は
**各 jsonl レコードに `roomId` と `surface` を付与**（ロガーが run のコンテキストから取得）。
発展で Room 別ファイル分割も可。これにより「この run は REPL か Discord か / どの Room か」が事後解析で必ず分かる。
- 5.1（source を実行コンテキスト化）と同じ「run はどの Room/面か」を必要とするため、両者は同じ情報源を共有できる。

### 5.6 大容量成果物の配達と「配達結果のフィードバック」（R-5 / Q4）
**方向（根本）**: 「生成」と「配達」を分離し、配達はサーフェス能力（サイズ上限・添付可否）に応じて選択
（Discord/Slack は **ファイル添付**を第一候補、無理なら分割）。そして **実際に配達された結果（成功/失効/切り捨て）を
ツール結果としてモデルへ返す**。これが無いと「届いたつもり」で偽完了する（§2.2/§2.3）。
- 併せて、生成途中切り（`構造的不完全`）からの継続が「完了を捏造」に転ばないよう、未完なら未完として扱う
  （これはモデル挙動だが、配達結果フィードバックがあれば「まだ届いていない」と接地できる）。

### 5.7 turn-1 confabulation（H-1）— 対策は層特定後（保留）
§4 H-1 の切り分けを先に実施。serving 層（prefix cache）なら設定/スコープ、model 層なら sampling/受容、
prompt 層なら関連注入の見直し。**現時点で対策（特にプロンプト追記）を本設計に含めない。**

---

## 6. 課題（Q1〜Q4）と方針の対応
| 質問 | 確定原因 | 方針 |
|---|---|---|
| Q1 ログは Room/面別か | R-4 プロセス単位・タグ無し | 5.5 各レコードに roomId/surface |
| Q2 背景面は autorun では | R-2(権限側)/R-1 | 5.3 事前承認ポリシー＋5.1 実行コンテキスト化 |
| Q3 ack＋webhook 後追い | R-2 ack は実装済/配信が失効token | 5.2 Bot Token 配信（ack 維持） |
| Q4 チャット出力ができない | Discord=R-2(401), REPL=R-5(打切+偽完了)+R-1 | 5.2 / 5.6 / 5.1 |

---

## 7. 実装の段階分割（合意後）
- **Phase 1（観測性の土台）**: 5.5 ログに roomId/surface タグ。以後の検証の前提（5.1 と情報源を共有）。
- **Phase 2（配信）**: 5.2 Discord 返信を Bot Token `channels/{id}/messages` 化（ack は維持）。Slack も同等方針で確認。
- **Phase 3（権限）**: 5.3 背景面の事前承認ポリシー（Room 単位）。同期確認は背景面で「中断・正直報告」へ。
- **Phase 4（安全弁）**: 5.4 stuck-loop 遮断。恒久エラーの早期 abort。
- **Phase 5（実行コンテキスト化）**: 5.1 source を発信元固定から実行コンテキスト解決へ（最大の構造変更。Phase 1 のタグ基盤の上で）。
- **Phase 6（配達抽象）**: 5.6 添付/分割＋配達結果フィードバック。
- **別トラック**: 5.7 H-1 切り分け（serving/model）。実装トラックと独立。

（順序は「土台→被害の大きい配信/権限→構造変更」。Phase 5 を最後にするのは影響範囲が最大のため。要相談で前後可。）

---

## 8. 未決事項（レビューで決めたい）
1. **走行中 run() の救出可否**（5.1）: REPL が Room B の goal-seek を奪って引き取れるようにするか。
   - 案A: 実行中 run の配達先/権限ポリシーを差し替え可能にする（複雑だが「覗いて継続」が自然）。
   - 案B: 走行中 run は触らず、明示の中断操作（例 `/room B takeover` = 中断→REPL source で再開）。
2. **背景面 auto-approve の既定範囲**（5.3）: `file_write`/`bash` を Room ポリシーでどこまで自動許可するか。
   サンドボックス内に限定する等の既定値。
3. **恒久エラーの判定**（5.4）: 「待っても直らない」を何で判定するか（401/認証・権限恒久失敗を即 abort 対象に含めるか）。
4. **進捗編集の実現**（5.2）: Bot メッセージ PATCH で「同一メッセージ更新」を維持するか、追記型にするか。

---

## 9. テスト方針
- 5.2: interaction token 失効後（>15分）でも Bot Token 経由で長文応答が届く回帰テスト（モック Discord REST）。
- 5.3: 背景面で未許可ツールが「無音 401」でなく「ポリシー判定 or 正直中断」になることの確認。
- 5.4: 同一エラー連続で run が `FAILURE_WINDOW` 内に打ち切られる単体テスト。
- 5.5: jsonl レコードに roomId/surface が入る round-trip テスト。
- 5.1: 同一プロセスで Discord 発 run 実行中に Room を移すシナリオの権限/配信経路の検証（案A/B により異なる）。
- 対話品質・実機 Discord は手動 TTY 検証（パイプ不可。`lllmAgents/CLAUDE.md` 準拠）。

---

## 10. 見直し条件（[[feedback_no_workarounds]] 準拠）
- 本書は「非同期面に同期 UI を持ち込まない」「失効トークンに配信を載せない」という前提変更。モデル/サービングが
  変わっても陳腐化しにくい構造側の設計。turn-1 confabulation（5.7）のみ層特定後に追補する。
