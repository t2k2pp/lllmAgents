# ToDo / Goal Slot ライフサイクル設計

> **ステータス**: 実装中
> **作成日**: 2026-05-17
> **位置づけ**: `docs/strategic-todo-design.md` と `docs/goal-seek-mode-design.md` の **slot 単位ライフサイクル** を集約整理した cross-cutting 設計書
> **動機**: `sandbox/harness-usability-review-2026-05-16.md` §1「既存 ToDo が長く、 現在タスクとの混線」 と、 コード調査で判明した「session 境界で slot がリセットされない」 構造欠陥への対処

---

## 1. 問題の所在

`todo-write.ts` の `todos` および `goal-slot.ts` の `_goal`/`_history` はモジュールスコープ singleton として保持されているが、 **誰がいつクリアするか** が未定義だった。

| 期待 | 実態 (修正前) |
|---|---|
| `/clear` で全 in-memory slot がリセット | ✗ `MessageHistory` のみクリア。 todos / goal は残存 |
| `/quit` → `--resume <id>` で前回 slot が復活 | ✗ `SessionData` に todos / goal が含まれず復元不可 |
| 同プロセス内 `/resume` で別 session の slot が混入しない | ✗ 直前 session の todos / goal がそのまま残る |
| ToDo の完了済みが system prompt 注入から消える | ✗ `completed` 状態でも `buildTodoSection` がフル表示し続ける |

結果として、 「ToDo の山が古いほど信頼度が落ちる」 「resume してもゴール文脈が消滅する」 という非対称な失敗が同居していた。

---

## 2. 設計原則

### 2.1 ToDo と Goal は独立 slot

ToDo と Goal は **異なる用途・異なる lifecycle** を持つ。

- **ToDo は Goal なしでも常用** (forward mode で戦略を可視化する主役)
- **Goal は ToDo なしでも成立** (goal-seek mode で acceptance criteria のみで回す)
- **両方ある時も連動しない** — goal-seek 退出は todo を tidy しない、 全 todo 完了は goal-seek を抜けない

唯一の例外: `enterGoalSeek(goal, seedTodos=true)` のときだけ、 acceptance_criteria を todos に **同期 seed** する (既存挙動)。 これは入口の便宜であり、 以降の lifecycle は独立。

### 2.2 セッション境界は単一の責任主体に集約

「session 境界 = in-memory slot 一斉リセット」 を担うのは 2 箇所のみ:

1. **`/clear` ハンドラ** (`src/cli/repl.ts`): 同プロセス内で「ここから新しい話」 を宣言する操作
2. **`restoreSession(sessionData)`** (`src/agent/agent-loop.ts`): 別 session を載せ替える操作

両者の先頭で必ず:

- `exitGoalSeek("abort")` (= mode を forward に戻し goal-slot をクリア)
- `clearTodos()`

を実行する。 これで cross-contamination は構造的に発生し得ない。

### 2.3 永続化対象は「slot 全体」

`SessionData` を拡張して todos と goal を **optional フィールド** で保存・復元する。

```ts
export interface SessionData {
  meta: SessionMeta;
  messages: Message[];
  todos?: TodoItem[];                // 戦略 ToDo の全状態
  goal?: {                            // goal-seek mode が有効だった場合
    definition: GoalDefinition;
    history: EvaluationRecord[];
  } | null;
}
```

- optional のため、 旧 session ファイル (`todos`/`goal` フィールドなし) はそのまま読める (= 後方互換)
- `saveCurrentSession()` で `getTodos()` / `getGoal()` + `getEvaluationHistory()` を読み出してセット
- `restoreSession()` は 2.2 のリセット直後に、 session 側の値を `setTodos()` / `restoreGoalState()` で書き戻す

新規 API: `goal-slot.ts` に `restoreGoalState(goal, history)` を追加する。 既存 `setGoal()` は history を `[]` リセットする仕様なので、 復元用途には使えない。

### 2.4 ToDo の active / archive 分離 (表示のみ)

ToDo store は単一配列を維持する。 物理的に 2 つの array に分けることはしない (=「あれ、 さっき完了した todo がどこにも無い」 系の事故を防ぐ)。

代わりに **system prompt 注入時のフィルタ** で区別する:

- **active** = `pending` + `in_progress` + `blocked` → `buildTodoSection()` でフル表示
- **completed** = system prompt には件数のみ `"completed: 3 件 (/todo all で表示)"` で末尾に圧縮表示
- **REPL `/todo` 表示** は明示モード:
  - `/todo` (引数なし) → active のみ
  - `/todo all` → 全件 (完了込み)
  - `/todo archive` → 完了済みを **物理削除** (= 永続的に消すオペ、 user 明示)

自動 archive は実装しない。 LLM が「さっき done にしたタスクどこ?」 と混乱する事故を構造的に回避する。 ユーザーが必要と判断したら `/todo archive` で明示的にスイープする。

### 2.5 Goal は二値で十分

Goal slot は 0 または 1 個の active goal を持つだけ。 「消化で消える」 概念は acceptance criteria 充足時の自動 `exitGoalSeek("completed")` と user 明示 `/exit-goal-seek` で既に成立しているため、 archive 概念は不要。

---

## 3. 実装マップ

| Phase | 対象ファイル | 変更内容 |
|---|---|---|
| A | `src/cli/repl.ts` | `/clear` で `exitGoalSeek("abort")` + `clearTodos()` |
| A | `src/agent/agent-loop.ts` | `restoreSession()` 冒頭で同上 |
| B | `src/agent/session-manager.ts` | `SessionData` に `todos?` と `goal?` を追加 |
| B | `src/agent/agent-loop.ts` | `saveCurrentSession()` で書き込み、 `restoreSession()` で復元 |
| B | `src/agent/goal-slot.ts` | `restoreGoalState(goal, history)` 新設 |
| C | `src/tools/definitions/todo-write.ts` | `buildTodoSection()` を active のみ + completed 件数表示に変更 |
| C | `src/cli/repl.ts` | `/todo` を `active`/`all`/`archive` サブコマンド対応に拡張 |
| C | `src/cli/completer.ts` | `/todo` のサブコマンド補完追加 |
| E | `tests/agent/todo-lifecycle.test.ts` (新規) | リセット・active 分離・session 復元の 3 観点をカバー |

---

## 4. 後方互換と影響範囲

- 旧 session JSON は `todos`/`goal` フィールドなしで読まれ、 復元後の slot は空 → 既存 user の resume 体験を壊さない
- `formatTodos()` は既存挙動 (全件) のまま `/todo all` 経路から呼ばれる
- `buildTodoSection()` の出力フォーマット変更で system prompt 注入結果が変わる。 ただし「completed は件数だけ」 という縮退方向であり、 active を見落とすリスクはない
- 既存テストは `/clear` 経由で todos がクリアされる挙動を期待していない (= 元々無関係) ので回帰しない見込み

---

## 5. 関連ドキュメント

- `docs/strategic-todo-design.md` — ToDo slot の設計原則
- `docs/goal-seek-mode-design.md` — Goal slot の設計と goal-seek mode
- `docs/goal-features-comparison.md` — 他社製品との比較 (Claude Code / Codex / lllmAgents)
- `sandbox/harness-usability-review-2026-05-16.md` — 本設計の動機となったレビュー
