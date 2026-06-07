# ツール呼び出しサルベージ — `<|tool|>call:` 形式の追加 設計書

> **ステータス**: ドラフト → 実装
> **作成日**: 2026-06-07
> **位置づけ**: `docs/multi-tier-harness-roadmap.md §4 Phase D-1`（tool-call format 正規化）の拡張。新subsystemではなく既存 `normalizeToolCalls` への 1 形式追加
> **経緯**: じゃんけんセッション `~/.localllm/sessions/mq2inppm-z0lh.json`（2026-06-06、gemma-4-12B-it）で露呈

---

## 1. 動機

### 1.1 露呈した取りこぼし

Gemma 12B でのじゃんけんが未完了になった。実ログ解析の結論:

- ハーネスは**ネイティブ function-calling**（`tools` 配列 24 個、`second_llm_consult` 含む）を送っている
- システムプロンプトにテキスト書式の指示は無い（`call:` も `<|tool|>` も無し）
- モデルは認知的に正しく動いた: explore 分類 → グーを決める → `second_llm_consult` を妥当な引数で呼ぼうとした
- しかしモデルは構造化 `tool_calls` ではなく**本文テキスト**に吐いた:
  ```
  <|tool|>call:second_llm_consult{prompt: "じゃんけん…あなたは何を出しますか？"}<|thought|>
  ```
- serving 層（llama.cpp/vLLM）がこのモデル出力を `tool_calls` に変換せず素通しし、`openai-compat` はネイティブ `tool_calls` しか見ないため取りこぼし → ツール未発火 → テキストのみエスカレーションで打ち切り

**これはモデルの能力不足ではなく、ハーネス/serving の継ぎ目の取りこぼし**。lllmAgents の主題（賢いモデル前提に逃げず、ハーネスが愚直に支える / `strategic-todo-design.md §1.1`）に照らせば、ハーネスが拾うべき。

**serving 側 fix の可否（検討）**: serving 層（llama.cpp の `--jinja` / vLLM の `--enable-auto-tool-choice --tool-call-parser`）で gemma の出力をネイティブ `tool_calls` に変換できれば本問題は出ない可能性がある。ただし (1) gemma-4-12B GGUF に対し正しく機能する tool-call parser が serving 側に存在するかは未確認、(2) ユーザーは多数のモデル・サーバ（vLLM/llama.cpp/Ollama）を実行時に切り替えるため、serving 設定に依存した解決は機種ごとに脆い。よって**クライアント側で機種非依存に拾う**方針を採る（serving 側が正しく変換するモデルでは `toolCalls.length===0` ゲートにより本処理は発火せず無害）。serving 側で恒久解決できたモデルが増えても、本 normalizer は他形式と共存し死蔵にならない。

### 1.2 既存インフラで 9 割解決済み

`src/agent/tool-call-normalizer.ts` の `normalizeToolCalls(text)` が、ネイティブ `tool_calls` が空のとき本文/思考から非標準形式を救済する仕組みを**既に持っている**:

- Mistral `[TOOL_CALLS] [...]`
- ChatML `<tool_call>{...}</tool_call>`
- Anthropic XML `<tool_call><function=..><parameter=..>`
- ReAct `Action: ..\nAction Input: ..`
- Plain JSON `{"name":..,"arguments":..}`

呼び出しは `agent-loop.ts:1075-1107`（本文・思考の両方で `toolCalls.length === 0` のとき発火、tier 非依存）。**今回必要なのは Gemma の `<|tool|>call:NAME{...}` 形式を 1 つ足すだけ**。

---

## 2. 設計

### 2.1 新 extractor: `extractPipeCallToolCalls`

観測形式の特徴:
- 先頭にパイプ区切りの制御トークン `<|tool|>`（変種として `<|tool_call|>` / `<|tool_code|>` を許容）
- `call:NAME` でツール名
- 直後に `{...}` で引数。**引数は緩い JSON**（`{prompt: "..."}` のように**キー未クオート**、JSON 不正）

抽出手順:
1. 正規表現で `<\|tool(?:_call|_code)?\|>\s*call:\s*([A-Za-z_]\w*)\s*\{` を探索しツール名と `{` の位置を得る
2. `{` から**文字列対応のバランス括弧スキャン**で `{...}` 本文を切り出す（`extractPlainJSONToolCall` と同方式。値内の `}` で誤切断しない）
3. 本文を**寛容パース** `lenientJsonParse`（§2.2）で object 化 → `arguments` 文字列へ
4. 複数出現に対応（`matchAll` ループ）
5. `cleanedText` は抽出領域を除去し、さらに残存する裸の `<|...|>` 制御トークンを掃除

`format` union に `"pipe-call"` を追加。

### 2.2 寛容 JSON パース `lenientJsonParse` + `coerceLooseJson`

`{prompt: "..."}`（未クオートキー）を救うため、段階的に試す:
1. `JSON.parse(s)` 成功ならそれ
2. 失敗時: `coerceLooseJson(s)` で正規 JSON に寄せてから再 parse
3. なお失敗なら `null`（= この抽出を諦める。推測で壊れた引数を渡さない）

**`coerceLooseJson` は正規表現ではなく単一構造走査（文字列認識型）で実装する**。理由: naive な正規表現（`/([{,]\s*)(\w+)\s*:/g` 等）は、文字列値の中に `, key:` のようなパターンが含まれると値の途中を誤ってキー扱いして JSON を壊し、fail-closed で救済を取りこぼす（例: `{prompt: "選べ: グー, チョキ"}`）。文字列リテラルの内外を追跡し、**構造的位置でのみ**変換する:

- **シングルクオート文字列 → ダブルクオート**: 内容を読み切り、`\'`→`'` / `\\`→`\` を解いてから `JSON.stringify(val)` で安全に再エスケープする（naive な `replace(/"/g, '\\"')` はエスケープ列を二重化・破壊するため使わない）
- **未クオートキー → クオート化**: 直前の構造文字が `{` または `,` で、識別子の直後（空白スキップ後）が `:` のときだけクオート化
- **バランス括弧スキャン `scanBalancedBrace`** はダブル/シングル両方のクオートを文字列として認識し、`{command: 'echo }'}` のような値内 `}` を誤切断しない

この関数群は本 extractor 専用に閉じる（他形式の挙動は変えない）。`scanBalancedBrace` のみ `extractPlainJSONToolCall` と共用（重複ロジック解消）。

### 2.3 誤検出ガード（重要）

- **`<|tool|>` 系マーカーを必須**にする。裸の `call:foo{...}` は散文と紛れるため**対象にしない**（特異性で誤検出を抑える）
- 引数が `lenientJsonParse` で復元できないものは抽出しない（§2.2 手順 3）
- 既存方針に倣い、ツール名の既知性検証は**この層では行わない**（未知ツールは下流の executor が拒否し、モデルが学習する）。tier 非依存で `toolCalls.length === 0` のときのみ発火するため、ネイティブ function-calling とは競合しない
  - 将来、誤検出が観測されたら「`tools` 配列との名前照合」を `normalizeToolCalls` に引数追加する余地を残す（現時点は YAGNI）
  - **拡張点メモ**: 「拾えた（`format="pipe-call"`）が下流 executor で未知ツールとして弾かれた」ケースは現状 normalizer 層に遡れず、誤検出チューニング用シグナルが失われる。将来この監視が要るなら `NormalizationResult` に `unknownTool?: boolean` を足し、既知ツール名リストを `normalizeToolCalls(text, knownToolNames?)` で受け取る形に拡張する（signature 変更を伴うため呼び出し側 `agent-loop.ts` も追従が必要）

### 2.4 試行順序

`tries` 配列で **mistral の次**に置く。`<|tool|>` マーカーは他形式（`<tool_call>` / `[TOOL_CALLS]` / 裸 JSON）と字面が重複しないため**順序自体は任意**だが、`{...}` を含むので **plain-json には必ず先行**させる（先に裸 JSON として食われないため）。early-exit 効率も兼ねて早めに置く。

---

## 3. 変更ファイル

| ファイル | 変更 | 目安 |
|---|---|---|
| `src/agent/tool-call-normalizer.ts` | `extractPipeCallToolCalls` + `lenientJsonParse` 追加、`tries` と `format` union に登録 | ~70 LOC |
| `tests/agent/tool-call-normalizer.test.ts` | `<|tool|>call:` 系のケース追加（正常/複数/未クオートキー/誤検出しないこと/cleanedText） | ~60 LOC |

`agent-loop.ts` は変更不要（既存の呼び出し経路に自動的に乗る）。

---

## 4. 評価 — 成功基準

1. **単体**: 新テストで以下が緑
   - `<|tool|>call:second_llm_consult{prompt: "..."}<|thought|>` → 1 件抽出、name 一致、args が `{"prompt":"..."}`
   - 複数 `<|tool|>call:` の連続 → 全件抽出
   - 未クオートキー `{prompt: "x"}` が `{"prompt":"x"}` に復元
   - シングルクオート `{'command': 'ls'}` を復元
   - **値内に `, ` `:` を含む `{prompt: "選べ: グー, チョキ"}` を壊さず復元**（文字列認識コアース）
   - 値に `}` を含む `{command: "echo }"}` をバランス括弧で誤切断しない
   - 散文中の `call: 〜` （マーカー無し）は抽出しない（誤検出ガード）
   - 復元不能な引数 `{command: }` は抽出を諦め `format="none"`
   - `cleanedText` から `<|tool|>...` / `<|thought|>` / 他制御トークンが消える
2. **回帰**: 既存 `tool-call-normalizer.test.ts` 全 pass（他形式に影響なし）
3. **e2e（実モデル）**: gemma-4-12B でじゃんけんを再走 → `second_llm_consult` が発火し勝敗まで完了
4. **非回帰（重要）**: ネイティブ `tool_calls` を正しく出すモデル（Qwen 等）で二重発火しない（`toolCalls.length === 0` ゲートで担保）

### 4.1 検証ステータス（2026-06-07 時点・正直な記録）

| 基準 | 状態 | 備考 |
|---|---|---|
| 1. 単体 | ✅ 完了 | normalizer 43/43 緑。実観測ログの生文字列と同等ケースを含む |
| 2. 回帰 | ✅ 完了 | 他形式テスト全 pass、全体 649+ pass（環境依存 5 failed は無関係） |
| 3. e2e（実モデル） | ⏳ **未実施（ユーザー環境で要実行）** | gemma-4-12B + vLLM 起動が必要で、Claude の手元では実行不可。下記手順参照 |
| 4. 非回帰（二重発火） | 🟡 コード根拠で担保・実機未確認 | `toolCalls` は `agent-loop.ts:499` で `const toolCalls: ToolCall[] = []` のローカル配列、stream の `tool_call` チャンクで push のみ → undefined でゲートを突き抜ける経路は無い。native FC モデルでの実機確認は要 |

**§4-3 e2e の実行手順（ユーザー向け）**: gemma-4-12B で「セカンドLLMとじゃんけんして勝敗を教えて」を再走し、(a) コンソールに `[tool-format] pipe-call 形式から 1 件…抽出`、(b) ops ログ（`tool-format` カテゴリ）に `format=pipe-call`、(c) `second_llm_consult` 発火と勝敗テキスト、を確認する。

> **検証対象の切り分け（評価者レビュー指摘）**: この §4-3 手順は **pipe-call 形式の抽出**（gemma 固有の `<|tool|>call:` 出力）の確認。§6 の**実行位置バグ**（抽出物が実行経路に乗るか）の確認は別物で、§6.5 の Qwen3.6 しりとり再走（露呈セッション mq34du2c と同条件）が対応する。前者は「抽出器」、後者は「配線」のテストであり、両方が必要。

**ストリーミング境界の懸念について**: `normalizeToolCalls` は `textContent += chunk.text`（`agent-loop.ts:683`）でストリームを**全量組み立てた後**（`for await` ループ完了後、同 1079 行）に走る。`<|tool|>` が chunk 境界をまたいでも組み立て済み全文に対して照合するため、chunk 分割の影響は受けない。

### 4.2 観測性

`normalizeToolCalls` 発火時、コンソール（`chalk.dim`）に加え **ops-logger に構造化記録**（`tool-format` カテゴリ、`format` / `toolCount` / `toolNames` / `source` / `tier`）を残す。非TTY・`--background` でも JSONL で `jq` 可能。誤発火頻度・発火元の事後調査に使う（全形式共通）。

### 4.3 フォローアップ

- **agent-loop 統合テスト**: 初版では「AgentLoop の test harness が無く新設コストが高いため見送り。該当コードは 2 行で normalizer 単体＋ops ログで実質カバー」と書いていたが、**これは誤りで、まさにその未テスト領域に §6 の実行位置バグが潜んでいた**。ops ログは事後証跡（実行されなくても抽出時点で記録される）であり事前の回帰防止にはならない。§6 修正に伴い `tests/agent/agent-loop-salvage.test.ts` を新設（mock provider で thinking/text にツール呼び出しを含む応答を流し、tool が実行されることを assert）。詳細は §6.5。
- **unknownTool シグナル**: §2.3 の拡張点（拾えたが下流で未知ツール弾き、を normalizer に遡らせる）

---

## 6. 実行位置バグ — 「抽出したのに実行されない」（2026-06-07 しりとりセッションで露呈）

> **これは §3 の中核前提の誤りを正す追記**。§3 は「`agent-loop.ts` は変更不要（既存の呼び出し経路に自動的に乗る）」（line 97）と書いたが、**その呼び出し経路自体が壊れていた**。salvage で tool 呼び出しを抽出しても、それを**実行に届けていなかった**。§4.3 follow-up（line 136）で「`textContent = cleanedText; toolCalls.push(...)` 経路の統合テストは harness 無しのため見送り」と明記した、まさにその未テストの隙間にバグがあった。

### 6.1 露呈したセッション

`~/.localllm/sessions/mq34du2c-63rj.json`（2026-06-07、メイン = Qwen3.6-27B）で「あなたとセカンドLLMでしりとりをして」と依頼 → **一手も進まずユーザー入力待ちに戻った**。

実ログ解析の確証:

- LLM ログ（`2026-06-07T01-45-13_main.jsonl` turn 6, `finishReason:"stop"`）: Qwen は **`reasoning_content`（thinking チャネル）の中に** tool 呼び出しを正しく書いていた:
  ```
  <tool_call><function=second_llm_consult><parameter=prompt>
  しりとりの実演中…【しりとり履歴】1. ねこ → 2. こだま ← あなたの番。「ま」から…
  </parameter></function></tool_call>
  ```
  モデルは認知的に完璧: 「ねこ」を受け「こだま」を選び、履歴を構築し、`second_llm_consult` で継続しようとした。
- ops ログ（`tool-format` カテゴリ）: `format=anthropic-xml, toolCount=2, toolNames=[todo_append, second_llm_consult], source=thinking, tier=T2` → **normalizer は 2 件正しく抽出していた**
- にもかかわらず保存メッセージ `[10]` は `content:""`・`tool_calls` なし・後続の tool 結果メッセージ無し → 空応答でターン終了

**モデルの能力不足ではない。ハーネスがモデルの正しい成果を捨てた**（メモリ `feedback_dont_underrate_local_llms`）。

### 6.2 根本原因 — 抽出が実行ブロックの「後」にある

`agent-loop.ts` の 1 イテレーションの処理順序:

1. ストリーミングで `textContent` / `toolCalls`(native) / `thinkingContent` を組み立て
2. （~843）max_tokens / 構造的不完全による継続チェック
3. （~868）`toolCalls.length>0` のとき narration を flush
4. （~878）coherence チェック（standard+ register、ズレ検出で nudge + `continue`）
5. **（~897）`if (toolCalls.length > 0)` → ツール実行して `continue`** ← native tool 実行はここだけ
6. （~1075）text からの salvage 正規化 → `toolCalls.push(...)` ※実行ブロックの**後**
7. （~1104）thinking からの salvage 正規化 → `toolCalls.push(...)` ※同じく後
8. 以降の `toolCalls.length === 0` ゲートは全スキップ → 最終応答経路で `addAssistantMessage(textContent, undefined, ...)` → `return`

`toolCalls` は各イテレーション先頭（`agent-loop.ts:499`）で `[]` に再初期化されるローカル配列。よって 6/7 で push しても、(a) 実行ブロック 5 は既に通過済み、(b) `continue` しても次イテレーションで再初期化される。**抽出した tool 呼び出しは ops ログに記録されるだけで一度も実行されず、空応答としてターンが終わる**。

これは pipe-call 形式に限らず**全 salvage 形式（Mistral / ChatML / Anthropic XML / ReAct / Plain JSON / pipe-call）に共通の欠陥**。salvage 機能は単体テストでパーサのみ検証され、e2e で実行まで到達したことが一度も無かった（§4.1 基準 3 が ⏳ 未実施だったため発覚が遅れた）。

### 6.3 修正

salvage 正規化ブロック（text 由来・thinking 由来の 2 つ）を**実行ブロック・flush・coherence の手前へ移動**する。これにより:

- 抽出した `toolCalls` が flush（narration 表示）→ coherence → 既存の実行ブロック(5) に自然に合流し、**native tool 呼び出しと同じ経路で実行される**
- `addAssistantMessage(textContent, toolCalls, {thinking})`（実行ブロック内）で正しく永続化される

あわせて **coherence チェックに `toolCalls.length === 0` ガードを追加**する。salvage は「モデルが続行のため tool を呼んだ」状態なので、これを coherence の「完了ズレ」と誤判定して drop し `continue` すると、せっかく抽出した呼び出しを再び取りこぼす。tool 呼び出しがあるなら実行を優先し、completion-coherence nudge は出さない（native tool 呼び出しにとっても同様に正しい）。

> **副次的バグ修正（開発者レビューで判明）**: 旧コードは coherence チェックが実行ブロックの前に `toolCalls.length` ガード無しで置かれていた。そのため **native tool 呼び出し（`response_complete` を含む）があっても coherence mismatch を検出すると `addAssistantMessage(textContent, undefined, …)` + nudge + `continue` で tool を実行せずにループを続ける**取りこぼし経路が潜在的に存在した。`toolCalls.length === 0` ガードはこれも同時に塞ぐ（coherence は「tool 呼び出しが一切無い」ときだけ働く）。`hasRC` を `false` 固定にしたのはこのガードの帰結（ガード下では `response_complete` は存在し得ない）。

**設計思想の明確化**: salvage は「モデルの正しい認知成果（serving 層が取りこぼした tool 呼び出し）を拾う」ための機構。**拾って終わりでは無意味で、実行まで届けて初めて目的を果たす**。§3 の「agent-loop 変更不要」は、抽出と実行の接続を自明と見なした誤り。抽出器の正しさ（単体）と、抽出物が実行経路に乗ること（統合）は別の保証であり、後者が今回欠けていた。

### 6.4 §3 / §4 への訂正

- §3 line 97「`agent-loop.ts` は変更不要」→ **誤り。実行ブロックより前に salvage を置く構造変更が必要**（本 §6.3）。
- §4 成功基準に追加（§6.5）。

### 6.5 追加の成功基準

5. **抽出物の実行到達（本バグの回帰防止）**: salvage で抽出した `toolCalls` が、native tool 呼び出しと同じ実行ブロックに到達し実行される。空応答経路・最終応答経路に落ちない。
   - ✅ **統合テスト新設済み**: `tests/agent/agent-loop-salvage.test.ts`（4 tests）。mock provider で「thinking に ChatML / Anthropic XML、本文に ChatML のツール呼び出しを含む応答」を流し、probe tool が実行されることを assert（probe の execute が `loop.abort()` を呼び次イテレーション冒頭で決定的に終了）。native tool_call チャンクの実行を健全性確認として併設。
     - **逆検証で本物の回帰ガードと確認**: 旧バグ版 `agent-loop.ts`（9f5ec2f）に差し替えると salvage 3 ケースが赤・native 1 ケースが緑（= 抽出器でなく配線の欠陥を正しく捕捉）。修正版では 4/4 緑。
   - e2e（実モデル・ユーザー環境、任意）: Qwen3.6 でしりとりセッション再走 → `second_llm_consult` が発火し複数手進む（ops に `source=thinking` 抽出 + 直後に tool 実行が続く）。露呈セッション mq34du2c と同条件。
   - **検証境界の教訓（評価者レビュー §N-3）**: salvage のような「変換 → 実行経路に乗せる」機能は、**変換器**（`normalizeToolCalls` = 単体テストで十分）と**配線**（抽出物が実行ブロックに到達する = ループ順序依存で単体不能 → 統合テストが要る）を**別の検証境界**として扱う。今回の盲点は「変換器が動く前提でのみ単体テストを書き、配線を検証しなかった」こと。今後 agent-loop のループ順序を触る変更では「配線テストはあるか」を必ず問う。

### 6.6 既知の限界（スコープ外）

- **`finishReason === "length"` で thinking 途中切れ**: thinking に tool 呼び出しを書いている最中にトークン上限へ達した場合、salvage より前にある truncation/継続チェック（`agent-loop.ts` ~843、`isTruncatedByLength`）が先に `continue` するため salvage は発火しない。これは本変更が導入した挙動ではなく（truncation チェックは旧来から salvage より前にある）、対応はスコープを大きく広げるため今回は不問。`length` 切れ時は継続生成で全文が揃った次イテレーションで salvage に乗りうる。

### 6.7 変更ファイル（§6 分）

| ファイル | 変更 |
|---|---|
| `src/agent/agent-loop.ts` | salvage 正規化ブロック 2 つを実行ブロック前へ移動、coherence トリガに `toolCalls.length===0` ガード追加（`hasRC` は false 固定で意図明示）、旧位置のブロック削除 |
| `tests/agent/agent-loop-salvage.test.ts` | **新規**。salvage 抽出物の実行到達を検証する統合テスト（§6.5） |
| `docs/tool-call-salvage-pipe-format-design.md` | 本 §6 追記、§3/§4 訂正 |

---

## 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-06-07 | 初版（Claude Opus 4.8 + user 議論）。既存 normalizeToolCalls への pipe-call 形式追加として設計 |
| 2026-06-07 | 引き継ぎ三者レビュー（設計者／開発者／評価者の各サブエージェント、引き継ぎ拒否条件のヒアリング形式）を実施し採用分を反映。主な修正: 文字列認識コアース（値内 `,:` 誤変換バグ）、シングルクオートのエスケープ／`}` 誤切断バグ、scanBalancedBrace のクオート種別追跡、ops-logger 構造化ログ、検証ステータスの明文化（e2e はユーザー環境送り）、roadmap §4 の tier 乖離修正 |
| 2026-06-07 | §6 追記: **実行位置バグ**（しりとりセッション mq34du2c で露呈）。salvage で抽出した tool 呼び出しが実行ブロックの後に置かれていたため一度も実行されず空応答でターン終了していた。§3「agent-loop 変更不要」の誤前提を訂正し、salvage を実行ブロック前へ移動＋coherence ガード追加。全 salvage 形式に共通の欠陥で、e2e 未実施（§4.1 基準3）のため発覚が遅れた |
| 2026-06-07 | §6 引き継ぎ三者レビュー反映。設計者: 死蔵 `hasRC` を false 固定／コメント訂正／設計書整理。開発者: coherence ガードが旧コードの潜在バグ（native tool 呼び出しの coherence 取りこぼし）も塞ぐことを明記。評価者: **統合テスト新設**（`agent-loop-salvage.test.ts`、旧コードで赤・修正版で緑を逆検証）、§4.3「ops で実質カバー」の過大主張を訂正、検証境界の教訓（変換器 vs 配線）を §6.5 に追記 |
