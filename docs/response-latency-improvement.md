# 応答速度改善 設計書 — 「速いモデルを使う」以外の案

> 対象: アプリの応答レイテンシ改善。 **メインLLMをより速いモデルに替える以外**の打ち手を網羅的に検討する。
> 最優先軸: **体感(UI)レイテンシ**（ユーザーが「待たされている」と感じる時間）。
> 位置づけ: `docs/agent-loop-efficiency-review.md` は **反復回数（マルチステップタスクの総ターン数）削減** を扱う。
> 本書はそれを補完し、**1ターンあたりの遅延・補助LLM往復・体感待ち時間** をカバーする。
> 作成日: 2026-06-18 / ステータス: 提案（実装は別タスク）

---

## 1. 結論サマリ

体感の待ち時間は次のように分解できる:

```
体感待ち時間 ≒ TTFT(最初の表示まで) + 生成時間 + 補助LLM往復 + 反復回数 × 1ターン遅延
```

「速いモデル」は主に *生成時間* と *1ターン遅延* を縮める手段だが、それ以外の項にも大きな改善余地がある。

| Lever | 何を縮めるか | 最有力案 | 効果 | 工数 | リスク |
|---|---|---|---|---|---|
| **A 体感(UI)** | TTFT・完了表示までの体感 | A1 ストリーミング既定/ハイブリッド表示 | 大 | 中 | 中 |
| **A 体感(UI)** | 補助往復の待ち | A2 ゲートの非同期化/オプト既定 | 中〜大 | 中 | 中 |
| **B クラウドAPI** | 1ターン遅延・コスト | B1 プロンプトキャッシュ(`cache_control`) | 大 | 中 | 小 |
| **C ローカルLLM** | prefill再計算 | C1 system promptの揮発値排除 | 大 | 小 | 小 |
| **D 反復回数** | 総ターン数 | 既存doc参照（一部実装済） | 大 | — | — |

**体感優先での推奨着手順**: `C1`（小工数・効果大）→ `A1(ハイブリッド)` → `B1` → `A2`。

---

## 2. 調査で確定した現況（根拠）

### 2.1 既定でストリーミングOFF（体感の最大要因）

- `src/index.ts:436` — `config.streamingDisplay ?? false`。 `src/agent/agent-loop.ts:324` も既定 `false`。
- スピナーモードはテキストを **バッファして応答完了後に一括 Markdown 表示** する
  （`agent-loop.ts:980-997` `flushAssistantText`、受信中は `810-831` の「受信中... (N tok, M tok/s)」スピナーのみ）。
- 結果として、生成中ユーザーには **本文が一切見えず、体感TTFT＝生成完了時間** になっている。
  プロトコルレベルでは `stream:true` で受信しているのに、表示は完了待ちというギャップ。

### 2.2 補助LLMがメイン応答完了を同期ブロック

応答テキストが出来上がっても、以下が **`response_complete` 確定前に同期実行** され、完了表示を遅らせる:

| ゲート | 発火 | 実装 | 呼び出し仕様 |
|---|---|---|---|
| intent / completion classifier | `agent-loop.ts:1399-1403` | `intent-classifier.ts:142-218` | stream, maxTokens=50, temp=0（ヒューリスティック失敗時のみ） |
| progress-judge | `agent-loop.ts:1258-1296` | `progress-judge.ts:129-148` | maxTokens=200, standard以上で最大3回 |
| evaluator | `agent-loop.ts:1350-1383` | `evaluator.ts:61-100` | agentic時は読取専用ツールで最大10往復 |

coherence-check（`agent-loop.ts:1111-1124`）は regex のみで LLM 呼び出しなし＝対象外。

### 2.3 system prompt 先頭付近に揮発値（ローカル/クラウド両方に影響）

- `src/agent/system-prompt.ts:196` が `Current datetime: ${localDatetime}`（**秒単位で変化**）を
  core identity 直後・project instructions / memory / skills / rules **より前** に注入。
- さらに `agent-loop.ts:351-353` の `composeQuasiSystemPrompt` が goal / todo セクションを毎ターン動的合成。
- 影響:
  - **ローカル(llama.cpp/vLLM)**: prefix KV キャッシュが毎ターン miss → 揮発値以降の prompt 全体を **prefill 再計算**。
  - **クラウド(Anthropic)**: 揮発値より後ろは prompt cache に乗らない。

### 2.4 プロンプトキャッシュ未実装（直接API経路）

- `src/providers/anthropic.ts` / `src/providers/azure-anthropic.ts` の `buildRequestBody` は
  `cache_control` を一切付与せず、毎ターン system prompt 全量を再送。
- 集計側は対応済: `agent-loop.ts:859-865` が `cachedTokens` を読み、`cost-calculator.ts` が割引単価で計上。
  しかし直接API経路では `cache_control` を送らないため **常に 0**。
- 一方 `claude-cli.ts:218` / `claude-agent-sdk.ts:169` / azure-gpt(Responses API) は自動キャッシュの恩恵あり。
  → **直接 Anthropic/Azure-Anthropic を使う構成だけがキャッシュ未活用**。

### 2.5 コンテキスト圧縮は同期ブロック

- `agent-loop.ts:624-635` — `shouldCompress` 時に `await compress()`。閾値は capability 由来（`capability.compressionThreshold`）。
  圧縮中はスピナーのみで、長対話では複数回発火し得る。

### 2.6 既に対処済（重複検討を避けるための記録）

- **HTTP keep-alive**: `src/utils/http-client.ts:41-44` で undici `Agent` をシングルトン化、接続プール再利用済み。TLS再ハンドシェイク削減は既に効いている。改善余地小。
- **tok/s・文脈サイズ可視化**: `ux-transparency.md`（2026-04-12 完了）で実装済。
- **反復回数系**: 同一引数リトライ検知（`recentFailures`）、bash累積警告、plan/todo過多検知は `agent-loop-efficiency-review.md` 提案の一部が実装済。

---

## 3. 改善案カタログ

### Lever A — 体感(UI)レイテンシ【最優先】

#### A1. ストリーミング表示の既定見直し（効果:大 / 工数:小〜中 / リスク:中）

現状スピナーモードでは「生成完了まで本文ゼロ表示」。これを崩す3案:

- **案a: 既定ON** — `config.streamingDisplay ?? true`。最小変更で体感TTFTを実生成速度まで短縮。
  - トレードオフ: ストリーム中は生テキスト表示で、`marked-terminal` による Markdown 整形は不可（インクリメンタルレンダリング非対応）。コードブロック/表が崩れて見える時間が生じる。
- **案b: ハイブリッド（推奨候補）** — スピナーモードのまま、**最初の文 / 先頭 N 文字を受信した時点で即時プレーン表示**し、残りはバッファ→完了後に Markdown 再描画。
  - 体感TTFTを大きく縮めつつ、最終表示は整形済みを保てる。`agent-loop.ts` の受信ループ（`791-833`）と `flushAssistantText`（`980-997`）の協調で実装。
- **案c: 据え置き＋初回チャンク可視化強化** — 表示方式は変えず、初回チャンク到達を明示（最小リスク・効果も小）。

> 体感最優先なら **案b** を推奨。案a はリスク（表示崩れ）が体感を逆に損なう懸念。

#### A2. 補助LLMゲートの非同期化 / オプト既定化（効果:中〜大 / 工数:中 / リスク:中）

応答テキストを **先に確定表示**し、progress-judge / evaluator は「表示後のバックグラウンド検証」へ回す。
再プロンプトが必要になった場合のみ追記する設計に変える（楽観的表示 → 必要時に訂正）。

- 代替: 「体感優先プロファイル」を設け、standard では gate を弱め production のみ厳格化。
- intent classifier はヒューリスティック判定の適用範囲を広げ、LLM 往復をさらに減らす（`intent-classifier.ts`）。
- 注意: 「緑の嘘」防止（未検証を完了と偽らない）との両立が必要。バックグラウンド検証で不整合を検出したら明示訂正する前提で設計する。

#### A3. 圧縮の体感対策（効果:中 / 工数:小 / リスク:小）

- 圧縮閾値を前倒し（`agent-loop-efficiency-review.md §4.8` と整合）。1回の圧縮対象を小さくし、ブロック時間を短縮。
- 圧縮中の進捗（対象メッセージ数・経過）を表示してブラックボックス感を低減。

### Lever B — クラウドAPIの1ターン遅延

#### B1. プロンプトキャッシュ導入（効果:大 / 工数:中 / リスク:小）

- `azure-anthropic.ts` の `buildRequestBody` で **system 末尾とツール定義に** `cache_control:{type:"ephemeral"}` を付与。
  さらに直近メッセージ境界に breakpoint を置き、会話履歴の前半をキャッシュ対象にする。
- 効果: 2回目以降のターンで system+履歴前半の prefill をスキップ → **TTFT短縮＋入力コスト最大90%減**。
- 集計・コスト計上は既存（`cost-calculator.ts` の cache 単価）をそのまま流用可能。
- **前提条件**: C1（揮発値排除）を先に入れないとキャッシュ境界より前に毎ターン変わる値が残り、効果が出ない。

### Lever C — ローカルLLMの1ターン遅延（KVキャッシュ前方一致）

#### C1. system prompt から揮発値を排除（効果:大 / 工数:小 / リスク:小）【最有力】

- `system-prompt.ts:196` の `Current datetime` を **プロンプト末尾へ移動** するか、
  日時が必要な場面は `current_datetime` ツール取得に寄せて system からは外す。
- goal / todo の動的合成（`composeQuasiSystemPrompt`）も、安定プレフィクスより **後ろ**に置く。
- 効果: ローカルLLMの prefix KV キャッシュ命中率が上がり、揮発値以降の **prefill 再計算を回避**。
  B1（クラウドのキャッシュ）の前提条件でもあり、**ローカル/クラウド双方に効く**。工数最小で効果大の本命。

#### C2. 入力トークン削減（効果:中 / 工数:小 / リスク:小）

- 大 tool_result 要約（既存 `truncateLargeToolResult`）の閾値調整、圧縮閾値見直しで毎ターンの入力サイズを縮小。
- system prompt 自体のスリム化（tier別の冗長部分。`prompt-optimization.md` / `system-prompt-redesign.md` と連携）。

### Lever D — 往復 / 反復回数（既存doc参照）

`docs/agent-loop-efficiency-review.md` の P0-P3 を要約参照（重複実装しない）:
同一引数リトライ検知、file_edit→file_read 抑制、build/run 集約、browser_snapshot キャッシュ、計画/Todo 過多検知。
一部は既に `agent-loop.ts`（`recentFailures` 等）に実装済。総ターン数の削減は体感にも直結するため継続課題。

---

## 4. 優先度マトリクス（体感(UI)レイテンシ最優先）

| 優先 | 案 | 効果 | 工数 | リスク | 主な該当ファイル |
|---|---|---|---|---|---|
| **P0** | C1 揮発値排除（datetime/goal-todo を末尾へ） | 大 | 小 | 小 | `system-prompt.ts:196`, `agent-loop.ts:351-353` |
| **P0** | A1(b) ハイブリッド即時表示 | 大 | 中 | 中 | `agent-loop.ts:791-833,980-997` |
| **P1** | B1 プロンプトキャッシュ | 大 | 中 | 小 | `azure-anthropic.ts:buildRequestBody` |
| **P1** | A2 補助ゲート非同期/オプト | 中〜大 | 中 | 中 | `agent-loop.ts:1258-1403`, `evaluator.ts`, `progress-judge.ts` |
| **P2** | A3 圧縮前倒し+進捗表示 | 中 | 小 | 小 | `agent-loop.ts:624-635`, `context-manager.ts` |
| **P2** | C2 入力トークン削減 | 中 | 小 | 小 | `truncateLargeToolResult`, `system-prompt.ts` |
| **P3** | D 反復削減（既存doc継続） | 大 | — | — | `agent-loop-efficiency-review.md` |

---

## 5. 「やらない」と判断した項目（重複検討の防止）

- **HTTP keep-alive 強化**: `http-client.ts:41-44` で undici Agent 接続プール再利用済み。追加効果は小。
- **より速いモデルへの変更**: 本書のスコープ外（要望により除外）。`/model` / capability tier で別途対応可能。

---

## 6. 次アクション

段階リリースを推奨:

1. **P0 を1 PR**（C1 揮発値排除 + A1(b) ハイブリッド表示）。最小工数で体感が最も変わる。
2. 効果計測（TTFT、ローカルでの prefill 時間、cachedTokens 比率）後に **P1**（B1 + A2）へ。
3. 計測指標は `cost-token-command-design.md` / LLM I/Oログ（`llm-logger.ts`）の usage を活用。

> 各案の詳細実装は、本書承認後に個別の実装タスク（必要なら個別設計書）として切り出す。
