# Goal Loop（決定的検証ゲート型ループ）設計書

> **ステータス**: ドラフト（提案 / レビュー前）
> **作成日**: 2026-06-18
> **種別**: 機能追加の提案（本書時点では**実装なし**。承認後に Phase 1 実装へ）
> **発端**: Zenn 記事「Write Loops Not Prompts — Goal Loop」(kenimo49) の思想を取り込めないか、という検討依頼
> **関連**:
> - 既存パラダイム: `docs/goal-seek-mode-design.md`
> - 評価ループ: `docs/evaluation-loop.md`
> - 反復実行: `docs/loop_feature.md`（`/loop` 時間反復）
> - 思想: `docs/harness-engineering.md`

---

## 0. 本書の主眼

機能の前に、まず**思想・概念の差**を明らかにする（§2）。理由は、lllmAgents には既に「ループ的」な機能が 3 つあり（`/loop` / `/goal-seek` / `/try`）、機械的には記事の Goal Loop に近い。しかし**制御の所有者と停止ゲートの性質が思想として異なる**。この差を言語化した上で、取り込む価値のある部分だけを `/goal-loop` として提案する（§3 以降）。

---

## 1. 記事「Write Loops Not Prompts」の思想

中心命題（Boris Cherny "I don't prompt Claude anymore. I have loops running that prompt Claude." に由来する loop engineering）:

> **プロンプトを書くのではなく、ゴールに収束するまでモデルを駆動する「ループ（小さなプログラム）」を書け。モデルはループの中のサブルーチンになる。**

ループの基本形:

```
state check → 次アクション決定 → 実行（コード/ツール）→ feedback 取得 → 検証（ゴール達成?）→ 未達なら戻る
```

要点:
- 人間の仕事は「タスクを完了させる良いプロンプト」を書くことではなく、「次にどんなプロンプトを投げ、結果を読み、続けるか止めるかを決めるシステム」を設計すること。
- 検証ゲートは理想的には**決定的な実体**（テストの exit code、ファイルの存在など = ground truth）であり、モデルの自己申告ではない。
- ゲートを信頼できるからこそ、無人で（"while you sleep"）走らせられる。

> 注: 記事本体は取得時 HTTP 403。概念は二次情報（loop engineering 解説記事群、§9 参考）で確認した。

---

## 2.【主軸】記事の Goal Loop と既存機能の思想差

### 2.1 既存3機能の停止ゲート

| 機能 | 実体 | 停止ゲート | 性質 |
|---|---|---|---|
| `/loop` (`src/loop/loop-manager.ts`) | `setInterval` で prompt を時間反復 | 時間間隔 | そもそも「完了」概念が無い |
| `/goal-seek` (`src/agent/goal-slot.ts` + `agent-loop.ts`) | 後ろ向き連鎖 paradigm。受入基準を `todo_write` に同期 | **LLM 判定**: todo 完了 + evaluator スコア ≥ 0.8 | モデルの自己評価 |
| `/try` (`src/tenacious/tenacious-runner.ts`) | Planner→Generator→Evaluator のサブエージェント再試行 | **LLM 判定**: スコア ≥ 7/10 | モデルの自己評価 |

### 2.2 思想の対比

「やっていることは近い」が、以下の軸で**思想が異なる**。ここが本書の核心。

| 観点 | 記事の Goal Loop（loop engineering） | 既存 `/goal-seek`（最も近い既存機能） |
|---|---|---|
| **制御フローの所有者** | **ループ（決定的コード）が所有**。LLM は呼ばれる側 ＝ サブルーチン | **モデルが所有**。agent-loop が LLM を呼び、LLM が次手も完了も確率的に決める |
| **作成物の単位** | 人間は「ループ ＝ 小さなプログラム」を書く。プロンプトは毎反復ループが生成する派生物 | 人間は自然言語の goal を書き、ハーネスが包む |
| **停止ゲートの性質** | **決定的・外部・客観**（exit code / テスト / ファイル存在 = ground truth） | **LLM の自己判断**（todo 完了 / evaluator スコア = モデルの意見） |
| **無人実行** | ゲートを信頼できるので放置可（"while you sleep"） | off-ramp ごとに `ask_user`。人間が会話ループ内に居る前提 |
| **コンテキスト戦略** | 反復ごとに**リセット**し、永続状態（goal + 直近の失敗）だけ持つ | 1 つの span 内で**圧縮しつつ継続**（※ `/try` はリセットする点で記事に近い） |
| **再現性** | ループ + 決定的ゲートで再現性が高い | end-to-end に確率的 |
| **人間の役割** | ハーネスを一度設計し、離れる | REPL で対話的に伴走 |

### 2.3 結論 — 取り込む価値のある差分

3 機能のどれも、記事の核である
**「ハーネス所有の決定的ループ ＋ ground-truth ゲート ＋ モデルは差し替え可能なサブルーチン」**
を満たさない。`/goal-seek` は形は最も近いが「モデル所有・LLM 判定」で本質が逆向き。`/try` は外側ループとコンテキストリセットを持つ点で近いが、ゲートが LLM スコアである。

すなわち取り込む価値があるのは **「検証ゲートを決定的な外部コマンドにし、その実行をハーネス自身が握る」** という一点に集約される。

補足: `docs/evaluation-loop.md §2.1` は理想ゲートとして「bash exit code = 0」を挙げているが、現状その決定的チェックを**ハーネスが自分で実行してループ条件にする**箇所は無い。`agent-loop.ts` の `pendingVerification` ナッジは「モデルに検証を促す」だけで、ゲートを握っているのは依然モデルである。ここが未踏。

---

## 3. 提案: `/goal-loop` コマンド

記事の思想を体現する最小単位として、**決定的検証ゲート型の外側ループ**を新コマンドで導入する。

### 3.1 形

```
/goal-loop [N] --check "<検証コマンド>" <タスク記述>
```

例:

```
/goal-loop 8 --check "npm test" 失敗しているテストを全部通るように修正して
/goal-loop --check "npm run build" 型エラーを解消して
```

- `N`: 最大反復回数（省略時の既定値は実装時に決定。目安 8）。
- `--check "<cmd>"`: ground-truth ゲートとなるシェルコマンド。exit 0 で達成。
- 残りがタスク記述（`@` メンションは既存 `resolveAtMentions` で解決）。

### 3.2 動作（OUTER loop をハーネスが所有）

```
goal を pin（タスク + 検証コマンド）
for i in 1..N:
  abort なら break
  agent.run(初回=タスク / 2回目以降=タスク + 直近の失敗出力)
  result = ハーネスが check コマンドを直接実行   ← LLM 経由でない
  if result.exitCode == 0: 完了して終了
  失敗の stderr 末尾を次反復へ注入（goal slot 経由）
  同一失敗の反復を検出したら ask_user（silent exit 禁止）
N 到達 → 中断報告（最後の exit code / stderr を提示）
```

ポイント = **check コマンドをモデルにツールとして実行させず、ハーネスが `node:child_process` で直接実行する**こと。これが「ループがゲートを握る／モデルはサブルーチン」という記事思想の具体化であり、既存3機能との決定的な違い。

### 3.3 命名と `/loop` 衝突の明記

| コマンド | 意味 | 本提案での扱い |
|---|---|---|
| `/loop` | 時間間隔の反復 | **不変** |
| `/goal-seek` | LLM 判定の後ろ向き連鎖 mode | **不変** |
| `/try` | LLM スコアの再試行 | **不変** |
| `/goal-loop` | **決定的ゲートの外側ループ** | **新規** |

- `handleCommand()` は token 完全一致の `switch`（`src/cli/repl.ts`）なので `/loop` と `/goal-loop` は機械的には衝突しない。
- 残るのは**概念的な混同**（`/loop` と `/goal-loop` を取り違える）。`/help` および各コマンドの usage で 4 者を相互参照して緩和する。

---

## 4. アーキテクチャ方針（実装時の指針 — 本書では実装しない）

既存資産の再利用を前提とする。

### 4.1 ループの所有層
- OUTER loop は REPL / runner 層が所有し、`/try` の `repl.ts` オーケストレーション流儀（`agentBusy` ガード、`agent.run()`、`isAborted()` での break、反復間のコンテキスト扱い）を踏襲する。
- **`AgentLoop.run()` と forward mode は不変**とする（回帰回避。`docs/goal-seek-mode-design.md` のリスク表「forward mode に回帰が入る → 影響:高」に従う）。

### 4.2 状態保持（goal-slot を再利用）
- `GoalDefinition`（`src/agent/goal-slot.ts`）に `check_command?: string` を追加（後方互換の optional）。
- 各反復の結果は `appendEvaluation()` に**決定的レコード**として積む: `passed = (exitCode === 0)`、`gap_hint = stderr 末尾`、`unmet = ["\`<cmd>\` exit <code>"]`。
- `buildGoalSlotSection()` が `gap_hint` / `unmet` を system prompt へ注入する**既存経路**で、失敗出力が自動的に次反復のプロンプトへ載る（圧縮にも耐える）。
- todo ゲートと競合させないため、`enterGoalSeek(goal, seedTodos=false)` で入る（受入基準を todo 化しない）。

### 4.3 検証コマンド実行（新規モジュール）
- `src/goal-loop/check-runner.ts` を新設。shell / sandbox / cwd の解決は `src/tools/definitions/bash.ts` を参照（Windows は git-bash、他は `/bin/sh -c`）。
- **tool 権限経路を通さず直接 spawn**する（= ループがゲートを握る思想の実装。副作用は「コマンドを走らせる」ことのみ）。
- timeout 必須。stdout / stderr は末尾 2〜4KB に切り詰め（`agent-loop.ts` の `truncateLargeToolResult` の発想を流用）。
- `src/goal-loop/goal-loop-runner.ts` に外側ループ本体（`runGoalLoop(opts, agent)`）を実装。

### 4.4 想定する新規 / 変更ファイル（Phase 1）
- 新規: `src/goal-loop/check-runner.ts`, `src/goal-loop/goal-loop-runner.ts`
- 変更: `src/agent/goal-slot.ts`（`check_command?` 追加）, `src/cli/repl.ts`（`case "/goal-loop"` 追加、`/try` を雛形に）、`/help` のコマンド一覧

---

## 5. セキュリティ

- check コマンドは `bash.ts` と**同一の sandbox / cwd**で実行する（エージェントの編集と同じ環境で検証されないと意味がない）。
- timeout を必須とし、暴走コマンドを打ち切る。
- 危険コマンド検査（`src/security/` の既存パターン）を check コマンドにも適用するか否かは実装時に判断（ユーザーが自分で打つコマンドなので緩めでよいが、ログには残す）。
- check はツール権限ダイアログを通さない設計のため、その旨を usage と本書に明記（毎反復の確認プロンプトを避けるため意図的）。

---

## 6. テスト方針（実装時）

`lllmagents-test` スキルおよび CLAUDE.md（非 TTY パイプモードは事前宣言、権限数字は `1`/`2`/`4`/`5`、`3` は禁止）に従う。

- **正常系**: `sandbox/` 配下に「修正するまで `npm test` が exit 1」な題材を置き、`/goal-loop 5 --check "npm test" ...` を投入。ハーネスが毎反復 `npm test` を自分で実行し、stderr を注入し、**exit 0 で停止**することを確認。
- **打ち切り**: 達成不能な check を与え、`N` で停止し最後の exit code / stderr を報告（無限ループしない / silent exit しない）ことを確認。
- **非干渉**: 直後に通常の `/goal-seek` を実行し、todo ゲート挙動が**不変**であることを確認（`check_command` は optional で無視される）。
- **abort**: 反復途中で Ctrl+C / Esc → 外側ループが `isAborted()` で break すること。

---

## 7. 既存機構との非干渉

- forward mode（`/goal-seek` 不使用時）の `run()` 経路は一切変更しない。
- `seedTodos=false` で入るため、既存の todo ゲート（`response-complete.ts`）と競合しない。
- `/loop` / `/goal-seek` / `/try` のコードパスは不変。

---

## 8. スコープと今後

- 本書は**提案のみ**。コード変更・新規ソース・commit は本タスクでは行わない。
- 承認後、Phase 1（§4.4 のファイル群）を別タスクで実装し、本書を実装に合わせて更新する。
- 将来拡張候補: 複数 check コマンドの AND/OR、check 成功後に LLM レビューを 1 回挟む「決定的ゲート → 主観レビュー」の二段ゲート、`/goal-loop` の結果を task-report 通知へ連携。

---

## 9. 参考

記事概念の確認元（記事本体は HTTP 403 で取得不可、二次情報で確認）:
- Firecrawl "Loop Engineering" — https://www.firecrawl.dev/blog/loop-engineering
- Addy Osmani "Loop Engineering" — https://addyosmani.com/blog/loop-engineering/
- Dragos Roua "I Write Loops, Not Prompts" — https://dragosroua.com/i-stopped-prompting-my-agents-i-write-agentic-loops-instead-heres-why/

---

## 10. 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-06-18 | 初版ドラフト。思想差の明確化（§2）を主軸に、`/goal-loop`（決定的検証ゲート型ループ）を提案 |
