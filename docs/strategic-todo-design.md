# 準システムプロンプト + 戦略 ToDo アーキテクチャ 設計書

> **ステータス**: ドラフト (レビュー前)
> **作成日**: 2026-05-15
> **位置づけ**: `docs/goal-seek-mode-design.md` Phase 2 の再構成 + `docs/harness-engineering.md` の延長線
> **関連**:
> - 上位: `docs/harness-engineering.md` (ハーネス設計の全体方針)
> - 連携: `docs/goal-seek-mode-design.md` (Goal Seek mode)、 `docs/ephemeral-context-design.md` (span 境界)、 `docs/internal_design.md`
> - 経緯: drawDot 試金石セッション `~/.localllm/logs/sessions/2026-05-13T23-07-30_main.jsonl` で露呈した構造的欠陥が動機

---

## 1. 動機

### 1.1 drawDot 試金石が露呈した構造的欠陥

弱モデル (Qwen3.6-35B / llama.cpp) で「32px ウサギを描く」 タスクを走らせた結果:

- T2 で 51 分、 69,052 字の思考。 text / tool 呼出ゼロ
- 思考末尾に **同じ段落の 3 回繰り返し** = stuck reasoning loop
- ハーネスが「空応答」 と判定して retry → placeholder に 69K 思考をテキスト挿入 → context が 9K → 79K → 148K → 251K と肥大
- HTTP terminated (50 分後) → user retry → 同パターン継続
- **何の進捗もなく数時間消費**

「賢いモデルを使えば解決」 は本質的な逃げ。 これは **ハーネスが「文法レベル」 (ツール呼んだか / text 出たか) でしか機能しておらず、 意味レベル (元依頼に近づいているか / 戦略が立っているか) のチェックが無い** ことが露呈した試金石だった。

### 1.2 浅い patch アプローチの行き詰まり

最初に検討した修正案 (北極星 anchor の周期再注入 / stuck 検出 nudge / 完了照合 Evaluator) は、 すべて「nudge を打つ場所を増やす」 = **同じ reactive patch を別レイヤーに重ねる** だけで、 失敗パターンと同じ paradigm を継ぎ足していた。 弱モデルでは context が膨らんで余計に悪化する。

### 1.3 user 由来の本質的洞察

会話を通じて固まった見解:

> 「Goal は **行き先 (北極星)** だが、 そこに着くには **今どこに居て、 何をするか** が要る。 これが ToDo。 思考は『高くジャンプするためのしゃがみ込み』 で、 ToDo を更新する予備動作。 戦略無しに反応的に動くと『出た結果に一喜一憂して全然前に進まない』」

「考え中も実はこの ToDo に含まれるかもしれません」 という指摘が決定的で、 **思考は孤立した phase ではなく、 ToDo の更新を介して構造化されるべき** という結論に至った。

---

## 2. 核心の設計原則

### 2.1 4 層アーキテクチャ

agent の状態を以下の 4 層で表現する:

| 層 | 役割 | 性質 | 居場所 |
|---|---|---|---|
| **Goal** (北極星) | 行き先 | mostly static、 user 由来 (対話で refine 可) | 準システムプロンプト |
| **Strategy / ToDo** | 現在地から goal までの経路 | dynamic、 思考が更新 | 準システムプロンプト |
| **思考** (deliberation) | ToDo を作る/更新する **予備動作** | turn 単位、 ToDo に resolve | 一時的 (ephemeral) |
| **Action** (tool 呼出) | ToDo に従った具体的な手 | iteration 単位 | conversation history |

旧設計の「Goal Slot」 は本層構造の **Goal + Strategy が混ざった** 概念だったが、 本設計で分離する。

### 2.2 準システムプロンプト層

「**動的に更新されるが、 毎 LLM 呼出で fresh に system prompt として渡される情報**」 を準システムプロンプトと呼ぶ。 通常の system prompt が静的なのに対し、 準システムは:

- 対話を通じて変化する (Goal の refine / ToDo の更新)
- 毎呼出で再合成 (置換型) → conversation history に蓄積しない
- 圧縮の影響を受けない (system に居る)

これにより:
- **Goal が history から埋もれない** (圧縮で削られない)
- **ToDo の最新ステータスが LLM から常時見える**
- **context が膨らまない** (delta が history に積まれない)

### 2.3 思考 → ToDo 化 → 実行のリズム

「予備動作としてのしゃがみ込み」 を構造化する:

```
[user input]
    ↓
[Goal (準system)] ── pin
    ↓
[思考 deliberation] ← ハーネスが促す
    ↓ (resolve)
[ToDo (準system)] ── 戦略 commit (= しゃがみ完了)
    ↓
[Action: tool 呼出] ── ジャンプ
    ↓
[結果 → 状態更新]
    ↓ (必要なら思考に戻る)
    ↓
[Goal 達成 → response_complete]
```

ポイント:
- 思考は **ToDo 化を介して具現化される**。 deliberation だけして action に行かないのは未収束
- ToDo は **戦略の commit signal**。 update されたら「方針が定まった」 と見なせる
- ハーネスは「ツール呼出が無い」 を即失敗にせず、 「**思考結果を ToDo に commit してください (todo_write 系)**」 と促す = 思考を肯定的に扱う

### 2.4 クリエイティブ自由 vs ハーネスガイドの線引き

ハーネスは **「何を作るか」 には口を出さず、 「どう進めるかの作法」 だけを支える**:

| LLM の自由 | ハーネスのガイド |
|---|---|
| ToDo の **内容** (何を / どう実装) | ToDo の **操作の意図** (append か replace か) |
| 思考の **構造** (検討の進め方) | 思考の **resolution 経路** (ToDo に commit する促し) |
| Goal 達成の **アプローチ** (順序 / 手法) | 進捗の **可視性** (準 system 層で常時表示) |
| Tool 選択 (どの tool で実現) | Tool の **API 設計** (意図ごとに分離して間違えにくく) |

---

## 3. 仕様

### 3.1 準システムプロンプトの合成

`MessageHistory.getMessages()` を毎呼出で動的合成に変える:

```ts
getMessages(): Message[] {
  const composed = this.composeSystemPromptFresh();
  return [{ role: "system", content: composed }, ...this.messages.map(/* inline thinking */)];
}

composeSystemPromptFresh(): string {
  const parts: string[] = [this.basePrompt];
  // 動的セクション (順序は末尾優先で attention を引きやすくする)
  const goalSection = buildGoalSection();        // Goal Slot active なら
  if (goalSection) parts.push(goalSection);
  const todoSection = buildTodoSection();        // todos があれば
  if (todoSection) parts.push(todoSection);
  const modeSection = buildModeSection();        // register / mode の自覚
  if (modeSection) parts.push(modeSection);
  return parts.join("\n\n");
}
```

#### 設計上の選択

- **composer の責務**: `MessageHistory` に **composer 関数を注入** (`setSystemPromptComposer(fn)`)。 具体的な合成知識は `AgentLoop` が持ち、 import 依存を作らない
- **配置**: 単一 system message の末尾に append。 マーカー (例: `# 現在の Goal` / `# 現在の ToDo`) で区切る。 複数 system message に分割は provider 互換性リスクあり
- **更新頻度**: 毎 `getMessages()` 呼出で再合成。 文字列生成は安く、 一貫性を優先

#### Claude Code との差異 (調査結果 2026-05-15)

Claude Code は **session-start のみで state を inject、 以降は conversation history + auto-compaction に依存**。 200K context window と十分な reasoning capacity 前提だから成立する設計。

本設計が **per-turn 再注入** を選ぶ理由:
- 弱モデル (短 ctx / 低 reasoning) でも一貫した state 参照を保証
- 圧縮の影響を受けない (system 層に常駐)
- context bloat ゼロ (delta が history に積まれない)

Claude Code 内部の `<system-reminder>` mechanism は **公開 API ではない** ため (内部 harness 機能)、 我々が同等効果を取るには独自の準 system prompt 再合成が必要。

### 3.2 ToDo 操作の分離 (案 C — Claude Code 流の disciplined アプローチ)

`todo_write` の wholesale 置換は **意図信号を失う** ため、 個別操作に分離する。 Claude Code 調査 (TaskCreate / TaskUpdate / 個別 delete) で「bulk reset 操作を持たない」 disciplined design が validated されたため、 我々もそれに倣う。

| ツール | 意図 | Phase |
|---|---|---|
| `todo_append(items)` | **既存に追加** (= 戦略の延長) | Phase 1 |
| `todo_mark(id, status)` | **状態だけ変える** (pending/in_progress/completed/**blocked**) | Phase 1。 LLM が「リスト全部書き直し」 で他項目を消す事故を防ぐ |
| `todo_delete(ids)` | **明示的な削除**。 暗黙削除 (= 書き忘れ) と区別 | Phase 1 |
| `todo_reorder(ids)` | 順序入れ替え | Phase 2 以降 |

**意図的に提供しない**: bulk reset 操作 (`todo_reset`)。 戦略を作り直したい場合は **`todo_delete` で対象を明示削除してから `todo_append`** という 2 段。 これにより:
- 偶発的な戦略破壊を防ぐ (delete は明示の意図表明)
- 「何を捨てたか」 が tool 呼出ログに残る (監査性)
- Claude Code の battle-tested design 思想に整合

#### 後方互換

既存 `todo_write(todos: [...])` は **compat shim** として残す:
- 内部で「現状の todo を全削除 → 新規 todos で append」 と等価動作
- description に **「[deprecated] 戦略の部分更新は todo_append / todo_mark / todo_delete を推奨。 wholesale 置換は新規作業の最初のみ」** と明記

#### 戦略破棄が必要な場面

- Goal が user 対話で変わった → 戦略を一新
- 現戦略が empirically 失敗 → 別アプローチに切り替え (e.g., drawDot で「dot 個別」 から「rect.fill 中心」 へ方針転換)
- Vision feedback で根本的問題発覚 → 全面再計画

これらは agent の自発的判断。 ハーネスは押し付けない。 推奨手順: 既存 todos を `todo_mark(id, "blocked")` で停止表明 → 必要に応じ `todo_delete(ids)` → 新戦略を `todo_append`。

### 3.3 空応答 retry の意味反転

現状の `MAX_EMPTY_RETRIES` フローは「ツール呼出が無い = 失敗 → 『ツールを呼べ』 と nudge」 を 3 回繰り返して諦め。 **これが「思考を禁止する圧力」 になり、 弱モデルが戦略を立てる前に反応的に動く原因**。

#### 改修

空応答時の nudge を以下に変更:

```
[ハーネス通知] 直前の応答で思考は記録されましたが、 実行に移っていません。

# 期待される次の手
あなたの思考から **戦略を ToDo に commit** してください:
  - 戦略がまだ deliberation 中なら: todo_append で「次に何を検討するか」 を 1-2 項目追加
  - 戦略が決まったなら: todo_reset で具体的な計画 (3-5 項目) を書き出す
  - 既存の todo に従って進めるなら: 該当 tool を直接呼ぶ

# 元依頼 (北極星)
{original_user_intent}
```

これで思考は「実行を引き出すための予備動作」 として正しく機能する。 「promise だけで終わらせない」 という既存原則とは対立しない (= `todo_append` / `todo_reset` は実装ツール扱い)。

### 3.4 stuck 状態の表現 — 検出より agent 自己宣言

ヒューリスティックでループ検出 → nudge は false positive が怖い。 Claude Code も「stuck 検出」 を harness で試みず、 **`blocked` task status で agent 自身に宣言させる** 設計。 我々もこれに倣う:

- `todo_mark(id, "blocked")` で agent が「この項目で進めない」 を表明できる
- description に明示: 「行き詰まった、 別アプローチが必要、 ask_user が要る場合は blocked を付ける」
- ハーネスは blocked が長期間 / 連続的に立っている状態を観測したら、 **scheduled polling 的に「方針見直しを検討しますか?」 と問う** (干渉せず確認のみ、 1 セッションで 1-2 回上限)

「思考が ToDo に commit していません」 系の自動 nudge は **空応答 retry の意味反転 (§3.3)** に集約。 ヒューリスティック検出 (思考量 / mark 往復 / completed 停滞) は **意図的に導入しない** (false positive 害が大きいため)。

ハーネスが過度に「これは stuck だ」 と判定するより、 **agent に状態表明の手段を提供して自己宣言させる** 方が誤検出が無く、 弱モデル / 強モデルどちらにも公平。

### 3.5 思考の保全 (前 commit の反省を含む)

前 commit (f85cb03) で実装した `Message.thinking` field の inline 化は、 **history に thinking を埋め込んで bloat を起こす** という drawDot doom loop の遠因になった。 本設計では:

- thinking は **ephemeral**: 次ターンの input に直接持ち越さない
- 代わりに、 **「最新ターンの思考要約」 を準システムプロンプトの 1 section として置く** 案を検討余地に残す (Phase 2 以降)
- 当面は thinking を ToDo 化させるフロー (3.3) で「結晶化」 し、 結晶化されなかった生の思考は捨てる

これは「考え続けるが ToDo に落ちない思考は無価値」 という割り切り。

### 3.6 Claude Code 先行事例からの取り込み候補

調査の結果、 以下のパターンは Claude Code に既にあり、 我々も Phase 2-3 で検討する:

| パターン | 効果 | 取り込み Phase |
|---|---|---|
| **path-scoped rules** (`.claude/rules/*.md` に `paths:` frontmatter) | ファイル touched 時のみ load。 大規模 codebase の指示を必要時のみ context に乗せる | Phase 3 |
| **PostToolUse hook + `additionalContext`** | 編集後の linter / verify 結果を即時 context に注入。 fast feedback loop | Phase 2 |
| **task DAG** (`dependsOn` 相当) | task 間の依存関係を明示。 階層 todo より柔軟 | Phase 3 |
| **Monitor 相当 (reactive stream)** | 長時間 process の出力を streaming で監視 | 必要性顕在化後 |

これらは本設計の中核 (準 system + ToDo 操作分離) と独立に追加可能。 取り込み順は Phase 1 完了後の評価で決める。

---

## 4. 段階実装計画

### 4.1 Phase 1 — 準システムプロンプト化 + ToDo 分離 (本設計の最小)

| Step | 内容 | LOC 目安 |
|---|---|---|
| 1 | `MessageHistory.setSystemPromptComposer(fn)` を追加。 `getMessages()` を composer 経由で動的合成に変更 | ~30 |
| 2 | `AgentLoop` で composer を実装 (basePrompt + goal section + todo section) | ~50 |
| 3 | 既存の `enterGoalSeek` / `exitGoalSeek` での明示的 `updateSystemPrompt` を撤去 (composer が自動カバー) | ~10 |
| 4 | 新規 tool: `todo_append(items)` / `todo_mark(id, status incl. "blocked")` / `todo_delete(ids)` | ~80 |
| 5 | 既存 `todo_write` を compat shim 化 (内部で全削除 + append、 description で deprecated 表記) | ~20 |
| 6 | system prompt の todo section builder (`buildTodoSection()`) — 現在の todos を整形 | ~40 |
| 7 | tool description を update — 「strategy commit のリズム」 「blocked status の使い方」 を明記 | ~20 |

合計 ~250 LOC。 既存 `todo_write` を呼ぶ LLM の挙動は compat shim で保たれるので回帰なし。 新規呼出は分離 tool を使う形に誘導。

### 4.2 Phase 2 — 空応答 retry の意味反転 + 非干渉ガイド

| Step | 内容 | LOC 目安 |
|---|---|---|
| 1 | 空応答時の nudge を「思考を ToDo に commit」 に変更 (`self-check-messages.ts`) | ~30 |
| 2 | retry counter のリセット bug 修正 (`emptyResponseRetries` が HTTP retry で消えない) | ~10 |
| 3 | 観測シグナル: ToDo の mark 往復 / completed 停滞を検出する hook | ~80 |
| 4 | ヒント注入 (非干渉) — 検出時に「reset 検討」 を 1 度だけ提示 | ~30 |

合計 ~150 LOC。

### 4.3 Phase 3 — Phase 2 以降の検討材料

- `todo_reorder` / `todo_delete` (必要性が顕在化したら)
- ToDo の親子関係 (= 階層構造) — 現時点は flat で十分と判断
- 「最新思考の要約 slot」 を準システムに追加 (思考保全の正しい形)
- Goal Seek mode の per-iteration gap evaluation (旧 Phase 2)

---

## 5. リスク

| リスク | 影響 | 緩和 |
|---|---|---|
| 準 system 再合成のたびに文字列生成 → CPU コスト | 低 (文字列結合は cheap) | 観測してから必要なら memoize |
| 既存 `todo_write` (compat shim) を新規開発でも使い続け、 分離 tool の恩恵が出ない | 中 | description で deprecated 明記 + 弱モデル試金石で実観測 |
| LLM が `todo_append` / `todo_delete` / `todo_mark` を混同 | 中 | description を明確化、 例示。 弱モデルでの動作観測必須 |
| 既存 `todo_write` を使う code 経路 (skill / 他 tool) との互換 | 低 | compat shim で温存 |
| `blocked` status を agent が使わず stuck を表明しない | 中 | description + skill 改修で「blocked の使いどころ」 を明示 |
| 準 system が肥大化して context を食う | 低-中 | section に上限 (e.g., todo は最新 20 件まで、 過去は要約) を設ける検討 |
| `MessageHistory` の composer 注入を忘れた経路で system prompt が古い | 中 | constructor で必須に。 注入しなければ build エラー or warn |

---

## 6. 評価 — 何を持って「成功」 とするか

### Phase 1 完了基準

1. **機能**: `todo_append` / `todo_mark` / `todo_delete` が動作。 既存 `todo_write` は compat shim として警告付きで残り、 旧呼出経路で回帰なし
2. **準 system 動的化**: goal slot が evaluation 更新時に最新版で送信されることをログで確認
3. **todo 可視性**: 圧縮を跨いでも LLM が最新 todo を視認できることを e2e で確認
4. **回帰ゼロ**: 既存 vitest が全件 pass、 forward mode session 5 件に挙動差なし

### Phase 2 完了基準

5. **drawDot 試金石** (Qwen3.6-35B、 32px ウサギ) を再走らせて:
   - 空応答 retry で「ToDo に commit を促す」 nudge が動作
   - thinking がループせず ToDo に結晶化される (少なくとも 1 iteration 内で)
   - context が 100K を超えない (現状 250K 越え)
   - 失敗してもユーザーに明確に「戦略未収束」 が伝わる (silent 失敗を避ける)

### 言語化されるべき結論

Phase 2 完了時、 「**ハーネスが愚直に支えれば、 弱モデルでも戦略的に動く** か」 を実証データで判断。 仮に弱モデルが結局通らなくても、 「ハーネスの構造的限界」 と「モデルの reasoning 限界」 が分離して見えるようになる (現状は両者の責任が不明確)。

---

## 7. 用語集

| 用語 | 意味 |
|---|---|
| **準システムプロンプト** | 毎 LLM 呼出で system role として送られるが、 動的に再合成される情報層 (Goal / ToDo / mode 等) |
| **Goal** | 北極星。 user 由来の行き先 |
| **Strategy / ToDo** | Goal から逆算した経路。 思考が更新 |
| **しゃがみ込み** | 思考 → ToDo 化の遷移。 ジャンプ (= action) の予備動作 |
| **resolve** | 思考が ToDo の更新に結晶化されること |
| **意図信号** | tool 呼出の選択 (append vs delete vs mark) でハーネスに伝わる agent の意図 |
| **非干渉ガイド** | ハーネスが観測シグナルからヒントを出すが、 操作は強制しない |
| **blocked status** | agent が「この todo で進めない」 を自己宣言する状態。 ハーネスはこれを観測して非干渉的に「方針見直しを検討するか」 と問う |
| **compat shim** | 既存 `todo_write` を後方互換のために残す薄いラッパ。 内部で「全削除 + append」 と等価動作、 deprecated 警告付き |

---

## 8. 未解決事項 / 議論残し

- **思考の保全方法**: 現在 inline で history に積んでいる方式は bloat の遠因。 「最新思考要約 slot」 として準 system 化する案を Phase 3 で検討
- **ToDo の hierarchical 構造**: 「描画順を検討」 が resolve したら子 todo (「シルエット → 顔 → 細部」) に展開、 のような構造。 現時点 flat で十分と判断、 必要なら Phase 3
- **register / mode の準 system 表示**: 「今は production レジスター / goal-seek mode」 を毎呼出で 1 行表示。 drift 抑制に効くはずだが、 noise になる可能性も。 Phase 1 で試験的に入れて観測
- **skill 経由のタスクで goal-pin を自動発火**: 旧 Goal Seek 設計の論点。 本設計の準 system 化が効けば必要性は下がるかも

---

## 9. 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-05-15 | 初版ドラフト (Claude Opus 4.7 + user 議論) |
| 2026-05-15 | Claude Code 調査結果を反映: bulk `todo_reset` を撤回し `todo_delete` + `todo_append` に / stuck 検出ヒューリスティックを撤回し `blocked` status の self-declaration 方式に / Claude Code 先行事例の取り込み候補を §3.6 に追加 / Phase 1 から `todo_reset` を削除 |
