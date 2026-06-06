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

---

## 5. 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-06-07 | 初版（Claude Opus 4.8 + user 議論）。既存 normalizeToolCalls への pipe-call 形式追加として設計 |
