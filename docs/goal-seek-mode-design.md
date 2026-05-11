# Goal Seek Mode — paradigm 切替型自律実行モード 設計書

> **ステータス**: ドラフト (レビュー前)
> **作成日**: 2026-05-11
> **タグ**: `pre-goal-seek-mode` (実装開始前の最終地点)
> **関連**:
> - 上位構造: `docs/internal_design.md`, `docs/harness-engineering.md`
> - 連携: `docs/agent-loop-efficiency-review.md` (self-check 機構), `docs/ephemeral-context-design.md` (span 境界), `docs/main-second-subagent-comparison.md` (sub-agent 役割)
> - 既存軸: `docs/multi-tier-harness-roadmap.md` (capability tier), agent-loop.ts:1423 (register table)

---

## 1. 動機

### 1.1 現状の駆動原理は forward-chaining 単一

現在の `AgentLoop.run()` (`src/agent/agent-loop.ts:373` 以降の `for` ループ) は、 各反復で以下を繰り返す:

1. 履歴 + system prompt を LLM に投げる
2. LLM が「次に何をすべきか」 を確率的に選ぶ (= LLM 本来の next-token 挙動)
3. ツール呼出が返れば実行、 テキストのみなら自己点検 / 完了判定

これは **forward-chaining** (前向き連鎖) の意思決定で、 LLM の native な挙動を agent loop がそのまま使っている。 利点はシンプルさと低コストだが、 以下の限界がある:

- **goal との照合がない**: 各反復で「この行動は当初の目標に近づくか?」 を機械的に問わない
- **register は style 軸のみ**: `explore / rough / standard / production` (`agent-loop.ts:191`) は forward-chaining 内での **stylistic variant** で、 paradigm は固定
- **完了判定が「LLM が完了と言ったか」 ベース**: `intent-classifier.ts` の `classifyCompletion` は元依頼との照合をしない (依頼の満足度ではなく LLM 発言の自己申告で判定)
- **改善ループの上限が浅い**: self-check は tier 別 1〜3 回 (`agent-loop.ts:367`)、 Evaluator も基本 1 周。 「合格まで何周でも回す」 機構が存在しない

### 1.2 Goal Seek パラダイムの提案

Excel の Goal Seek (目標値を決めて変数を逆算する) と同じ思想で、 **backward-chaining** (後ろ向き連鎖) の意思決定を導入する:

1. ターン頭で goal 状態を明示
2. 現在地と goal の **gap** を測る
3. gap を縮める方向の行動を選好
4. gap = 0 (acceptance criteria 全合格) で完了

forward-chaining との違い:

| 項目 | Forward-chaining (現状) | Goal Seek (新規) |
|---|---|---|
| 駆動原理 | 「直前まで → 次の確率的選択」 | 「goal → 現在地 → gap を埋める」 |
| 完了判定 | LLM 自己申告 (`classifyCompletion`) | acceptance criteria 全合格 |
| 反復上限 | tier 別 hard cap (50-100) で打ち切り | 収穫逓減検出 + 安全 cap |
| goal の保持 | 履歴の中に埋もれる (圧縮で劣化) | 専用 slot で圧縮対象外 |
| 視点 | 実装者単視点 | 設計者 / 実装者 / 評価者の多視点 (Phase 2+) |

### 1.3 user 起点で発火する設計とした理由

paradigm 切替は **stakes が高い** ため、 AI 自動判定ではなく **user 明示** をトリガーとする。 理由:

- Goal Seek の前提 = 「具体的な goal がある」。 それを知っているのは user だけで、 構造的に AI が判定するには情報不足
- 誤発動すると **user 想定外の goal で延々 grind** するコスト/リスクが大きい
- 「合格まで自走する」 という挙動への trust decision を、 AI が勝手にスイッチするのは設計として筋が悪い
- AI suggest (= 「向いてそうですよ」 と提案) は許容するが、 toggle 権限は user 専有

これは register (= AI 自己宣言可) との **本質的な性質差**。 register は style、 mode は paradigm。

---

## 2. 核心の設計原則

### 2.1 mode と register は直交軸

- **register** (既存、 AI 自己宣言可): `explore / rough / standard / production` — forward-chaining の **style**
- **mode** (新規、 **user 明示のみ**): `forward / goal-seek` — **paradigm**

両者は直交し、 「goal-seek mode + production register」 のような組み合わせが成立する。 同じ enum / table に混ぜない。

### 2.2 user 明示のみ、 AI 自動判定なし

`/goal-seek <自然言語>` スラッシュコマンドで明示的に発火。 AI 側に切替権限はない。 `assistant.text` から register を検出する `detectRegisterFromText` (`agent-loop.ts:1439`) のような自動検出は **実装しない**。

### 2.3 AI suggest は許容、 toggle は user

完全 manual だと user が機会を逃すこともある。 ヒューリスティック (例: self-check 連続発火 / `todo_write` で複数 acceptance criteria が立っている) で AI が `ask_user` を介して提案するのは可。 ただし **switch 権限は user 専有**。

### 2.4 Pin (Goal Slot) は mode の構成部品

Goal を圧縮で消えない slot に保持する Pin 機構は、 単体の機能ではなく Goal Seek mode の **不変量** として実装する。 forward mode では Pin を立てない (= 初回 pin の誤権威化リスクを回避)。

### 2.5 既存メカニズムを温存

Goal Seek mode は forward mode と **並立**。 既存の register / self-check / Evaluator / todo_write / response_complete はそのまま残す。 forward mode の挙動は変更しない (回帰リスク回避)。

---

## 3. 仕様

### 3.1 mode 軸の追加

`AgentLoop` に新フィールド:

```ts
type AgentMode = "forward" | "goal-seek";
private currentMode: AgentMode = "forward";
```

`currentRegister` (`agent-loop.ts:191`) はそのまま。 `currentMode` は **user 明示のみで変化** する。

mode 取得 API:

```ts
getMode(): AgentMode;
enterGoalSeek(goal: GoalDefinition): void;  // user 経由のみ呼ばれる
exitGoalSeek(reason: ExitReason): void;
```

### 3.2 Goal Slot の構造

`src/agent/goal-slot.ts` 新規。 `todo-write.ts` の `getTodos()` と同じく **メッセージ履歴の外側** に持つ singleton-ish モジュール。

```ts
export interface GoalDefinition {
  statement: string;              // 自然言語の goal 記述
  acceptance_criteria: string[];  // 検証可能な観点 (LLM が要約して user 承認)
  created_at: number;
  register_at_creation: Register; // 入口時の register を記録 (style 連動)
}

export interface GoalSlot {
  goal: GoalDefinition | null;
  history: EvaluationResult[];    // 各反復の評価スコアを蓄積 (収穫逓減検出用)
}

export function setGoal(g: GoalDefinition): void;
export function getGoal(): GoalSlot;
export function appendEvaluation(r: EvaluationResult): void;
export function clearGoal(): void;
```

**圧縮対象外**: `HierarchicalCompressor` の L1/L2 prompt に「Goal Slot は別途保持されているので要約に含めなくてよい」 と明記。 `buildContextSummary()` の出力には Goal Slot を含めない (二重注入になるため)。

**system prompt への注入**: Goal Seek mode 中、 各ターンの system prompt 末尾に Goal Slot をそのまま prepend する (これにより圧縮の影響を受けない、 LLM が常に最新の goal を視認できる)。

### 3.3 user 発火経路

#### 3.3.1 `/goal-seek <自然言語>` コマンド

CLI / REPL で受け付ける slash command。 既存 slash command 機構 (`src/cli/`) に追加。

```
/goal-seek llama.cpp の --parallel 設定を自動最適化する機能を追加
```

#### 3.3.2 goal 確定の 3 ステップ往復

```
[step 1] user: /goal-seek <自然言語>
[step 2] AI:   goal を要約 + acceptance criteria 案 3-5 個を提示 → ask_user で確認
[step 3] user: 承認 / 修正 / 取消
[step 4] AI:   setGoal() を呼び Goal Seek mode 開始
```

step 2 で AI が一方的に decide せず必ず ask_user を介す。 誤理解の早期検出。

#### 3.3.3 `/exit-goal-seek` コマンド

user 明示で mode 終了。 `clearGoal()` + `currentMode = "forward"`。

### 3.4 gap 評価のメトリクス

#### 3.4.1 評価器の構造

既存 `Evaluator` (`src/agent/evaluator.ts`) を **拡張** して再利用する。 新規に独立評価器を作らない。

評価器の出力:

```ts
interface EvaluationResult {
  iteration: number;
  scores: Record<string, number>;  // criterion_id → 0.0-1.0 (or null=未到達)
  unmet: string[];                  // 未達成 criterion の自然言語記述
  gap_hint: string;                 // 次に何をすべきかの 1-2 文ヒント
  passed: boolean;                  // 全項目 ≥ 0.8 で true
}
```

#### 3.4.2 評価のタイミング

- **goal-seek mode 中の各反復終了時** (= ツール実行後、 次の LLM 呼出前)
- forward mode では呼ばれない (回帰なし)
- 評価結果を `appendEvaluation()` で蓄積、 system prompt に直近の `gap_hint` を注入

#### 3.4.3 評価の駆動 LLM

- T1 (高品質モデル) が利用可能なら secondLLM (= 別モデル) で評価。 main と異なる視点を得る (`docs/main-second-subagent-comparison.md` の発想)
- T1 不可なら main と同じモデル。 prompt で「評価者として振る舞え」 と分離

### 3.5 収穫逓減 (diminishing returns) の検出

直近 N=3 反復の scores を見て:

- **全 criterion の平均スコアが ε=0.02 未満しか改善していない** かつ
- **unmet criterion 集合が変わっていない**

→ 収穫逓減と判定。 即終了せず、 **ask_user で「ここで一旦止めますか?」 と提案**。 user が「続ける」 を選んだら閾値を緩めて続行。

### 3.6 off ramp の優先順

```
(1) 全 acceptance_criteria 合格 → ask_user 「これで完了でいいですか?」 → 承認で exit
(2) user 明示 (/exit-goal-seek / abort)
(3) hard cap 到達 (iteration cap = standard register の 2 倍, 時間 cap = N 分)
    → ask_user 「上限到達。 続行 / 中断?」
(4) 収穫逓減 → ask_user 「停滞気味。 ここで止める?」
```

**すべて ask_user を介す**。 silent な強制終了は禁止 (user surprise 回避)。

### 3.7 AI suggest の発火条件

forward mode 中、 以下を満たすと AI は **1 度だけ** `/goal-seek` を提案する (`ask_user` 経由):

- `todo_write` で 3 個以上の acceptance criteria が立っている
- かつ self-check が直近 2 反復連続で発火している (= drift の兆候)
- かつ register が `standard` 以上
- session 内で既に提案済みでない

提案文:

> 「現在のタスクは acceptance criteria が複数立っており、 forward mode では十分に詰めきれていないようです。 `/goal-seek` モードで自動的に合格まで詰めますか? (yes/no)」

### 3.8 mode の有効範囲

- **session scope**: 1 つのセッション内で 1 つだけアクティブな Goal Slot を持つ
- **sub-agent への伝播**: sub-agent は **forward mode 固定** とし、 親の goal を delegate prompt に文字列として渡すのみ。 sub-agent 内で再帰的に goal-seek mode に入ることは禁止 (制御フローが追えなくなるため)
- **plan-mode との関係**: `/plan` (plan-mode) 中は `/goal-seek` を受け付けない。 plan-mode が exit してから受け付ける

### 3.9 既存コンポーネントとの役割分担

| コンポーネント | forward mode (既存) | goal-seek mode (本設計) |
|---|---|---|
| `AgentLoop` | 主ループ、 forward-chaining | 主ループ、 各反復で gap 評価 + Goal Slot 注入 |
| `Evaluator` | file 書込後の 1 回レビュー | 各反復終了時に goal 全体を評価 (Phase 1) |
| `sub-agent` | 委任作業の実行 | 設計者視点レビュー (Phase 2+) |
| `plan-mode` | 計画立案 | mode 入口で設計内容を Goal Slot に変換可 |
| `todo_write` | acceptance checklist | Goal Slot の acceptance_criteria と同期 |
| `response_complete` | LLM 自己申告で span 終了 | acceptance 全合格時のみ呼べる (force 必須) |

### 3.10 圧縮との相互作用

- `HierarchicalCompressor` の L1/L2 prompt に「Goal Slot は別保持のため要約から除外可」 と明記
- `MessageHistory.replaceOlderMessages()` (`message-history.ts:105`) で圧縮しても Goal Slot は影響なし (slot は履歴の外)
- 圧縮直後の system prompt 再構築時に Goal Slot を再注入 (二重ノイズ防止のため、 圧縮要約の中には goal を入れない設計)

### 3.11 A/B telemetry

`chatLogger` / `llmLogger` に以下のタグを追加:

```ts
interface SessionMetadata {
  mode: "forward" | "goal-seek";
  goal_id?: string;
  register: Register;
  tier: CapabilityTier;
}
```

比較メトリクス:

- **total tool calls** / **total LLM cost** (tokens × price)
- **time to completion** (wall clock)
- **final evaluator score** (acceptance criteria 達成率)
- **user grade** (任意。 `/grade <1-5>` で後付け評価可)

同じタスクを両 mode で実行 → side-by-side 比較を可能に。

---

## 4. 段階実装計画

### 4.1 Phase 1 — 最小実装 (~400 LOC)

**目的**: paradigm 切替の挙動を最小コードで動かし、 有効性を観測する。

実装範囲:

1. `src/agent/goal-slot.ts` 新規 (50 LOC)
2. `AgentLoop` に `currentMode` / `enterGoalSeek` / `exitGoalSeek` 追加 (50 LOC)
3. `run()` の `for` ループ頭に 1 ブロック追加 (~100 LOC):
   - `if (currentMode === "goal-seek")` で gap 評価 + Goal Slot 注入
4. `/goal-seek` / `/exit-goal-seek` slash command (REPL) (~50 LOC)
5. goal 確定の 3 ステップ往復 (~80 LOC)
6. `Evaluator` を goal 全体評価に拡張 (~50 LOC)
7. `HierarchicalCompressor` prompt に Goal Slot 除外注記 (~10 LOC)

**範囲外** (Phase 1 では入れない):

- Strategy パターンへの構造リファクタ
- 設計者 / 実装者 sub-agent の役割分担 (Evaluator 1 視点のみ)
- AI suggest の自動発火
- 詳細な A/B telemetry (基本 logger のタグだけ)

### 4.2 Phase 2 — Strategy パターン分離 (条件付き)

**Phase 1 の評価で「有望」 と判断されたら実施**。 そうでなければ Phase 1 を保守モードに置く。

- `run()` のループ本体を `LoopStrategy` インタフェースに切り出す
- `ForwardStrategy` (現状ロジック移植) / `GoalSeekStrategy` (Phase 1 のロジック移植)
- 切替コストを最小化、 future の paradigm 追加 (Plan-First mode 等) に備える

### 4.3 Phase 3 — 多視点 sub-agent + 本格 A/B

- 設計者視点 sub-agent (アプローチ妥当性レビュー、 5 反復ごと等)
- A/B telemetry の本格化、 比較レポート出力
- AI suggest の自動発火条件チューニング

### 4.4 マイルストーン

| Phase | 完了基準 | 期間目安 |
|---|---|---|
| Phase 1 | 1 件のサンプルタスクで両 mode が動作、 telemetry で差分が観測可能 | 1-2 週間 |
| Phase 2 | Strategy パターン適用、 既存 forward mode に回帰なし | +1 週間 |
| Phase 3 | 5 件のタスクで A/B 比較レポート、 推奨される使い分けが言語化 | +2-3 週間 |

---

## 5. リスク

| リスク | 影響 | 緩和策 |
|---|---|---|
| 各反復の gap 評価でコスト爆発 | 高 (毎反復 LLM 呼出が 1 回追加) | T3 では Goal Seek 無効化、 評価間隔を調整可 (毎 N 反復) |
| 誤 pin の権威化 | 中 (誤った goal で延々 grind) | 入口で必ず ask_user 確認、 user は `/exit-goal-seek` で即抜け可 |
| 収穫逓減検出の閾値設定が難しい | 中 (頻繁すぎる中断 or 永遠に止まらない) | ε / N は config 化、 初期値を保守的に設定 |
| sub-agent が goal を継承して暴走 | 低 (Phase 1 では sub-agent forward 固定) | sub-agent 内での goal-seek mode を禁止 (3.8 参照) |
| forward mode に回帰が入る | 高 (既存ユーザー全員に影響) | Phase 1 で `currentMode === "forward"` の path は一切変更しない、 テストで保証 |
| 圧縮との二重注入 | 低 (Goal Slot が要約にも入って context 浪費) | L1/L2 prompt の改修 + 二重チェックのテスト |
| ask_user 多発で UX 悪化 | 中 (off ramp ごとに ask_user) | 提案には short-cut (`/exit-goal-seek`) も併用 |

---

## 6. 評価 — 何を持って「成功」 とするか

Phase 1 完了時の判定基準:

1. **機能**: `/goal-seek <自然言語>` で発火 → goal 確定 → 反復実行 → acceptance 合格で `response_complete` 呼出、 までが一気通貫で動く
2. **回帰なし**: 既存 forward mode のセッション 5 件を実行し、 挙動・コスト・時間に有意差がない
3. **観測可能**: telemetry で mode タグが取れ、 acceptance スコア履歴が記録される
4. **off ramp**: 3.6 の (1)〜(4) すべてが手動再現でき、 silent exit が無いことを確認

Phase 3 完了時:

5. **比較データ**: 同一タスク 5 件以上を両 mode で実行、 コスト/時間/品質を表化
6. **使い分けの言語化**: 「Goal Seek が forward に勝るのはどんなタスクか」 が 1 段落で書ける

---

## 7. 未解決事項 / 今後の拡張

- **goal の階層化**: 現状は flat な acceptance_criteria 配列。 大規模タスクでは「session goal / current task goal」 の階層が必要かもしれない (議論で言及済み)
- **goal の更新**: mode 中に user が「goal を修正したい」 と言ったときの再確定フロー
- **複数 mode の連鎖**: plan-mode で計画 → goal-seek mode で実行、 という連結を slash で繋ぐ
- **Plan-First mode**: forward / goal-seek に加えて、 「計画を全部出してから一切迷わず実装」 という別 paradigm も将来候補
- **`/grade` コマンド**: user が完了後にセッションを 1-5 で評価し、 A/B 比較のラベルとして使う

---

## 8. 用語集

| 用語 | 意味 |
|---|---|
| **mode** | agent loop の駆動原理。 `forward` / `goal-seek` の 2 値 |
| **register** | forward-chaining 内での style。 `explore` / `rough` / `standard` / `production` |
| **Pin (Goal Slot)** | goal を圧縮で失わない slot に保持する機構 |
| **gap** | 現在地と goal acceptance criteria の差分 |
| **収穫逓減** | 反復しても評価スコアが頭打ちになった状態 |
| **off ramp** | mode から抜ける経路 (完了 / 中断 / cap / 逓減) |
| **suggest** | AI が `/goal-seek` を提案するヒューリスティック (toggle 権限は user) |

---

## 9. 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-05-11 | 初版ドラフト作成 (Claude Opus 4.7 + user 議論) |
