# /cost コマンド（クラウドLLM コスト/トークン可視化）設計

作成: 2026-06-01 / 対象: `src/cost/`, `src/cli/repl.ts`, `src/cli/completer.ts`

## 1. 背景・課題

クラウドLLM を本格利用できるようにしたため、使用量の可視化ニーズが増した。現状:

- per-call で `model/provider/in/out/cached/cost/sessionId` を**記録済み**（`TokenUsageRecord`）。
  記録箇所は main（`agent-loop.ts:687`）と second（`second-llm-manager.ts:324,456`）。
- しかし集計 `getSessionTotal()` は**全部合算するだけ**（per-model/provider なし = 「一括り」）。
- `/status` の Cost 行は 1 行のみ。旧 `/cost` `/metrics` は 2026-05-28 に `/status` へ集約・削除済み。
- `flush()`（月次 jsonl 永続化）は**どこからも呼ばれずデッドコード**。`~/.localllm/usage/` も未作成。
- 「いつから計測」「リセット」の概念なし。再起動で消える。

**データは細かいのに、集計・永続化・計測窓だけが未整備。** これを埋める。

## 2. 方針（ユーザー合意済み 2026-06-01）

- コマンドは **`/cost` にサブコマンド集約**（`/token` は alias）。サブコマンドも入力補完対象。
- 計測窓は **永続累計**（flush を生かし月次 jsonl 永続化、起動をまたいで累計）。
- 集計軸は **モデル別 / provider・slot 別 / 時系列・期間別 / 単価・算出根拠** の全 4 軸。

## 3. データモデル

### 3.1 `TokenUsageRecord` 拡張

`slot` を追加（main/second/vision のどのスロットの消費か）。後方互換のため optional + 既定 "main"。

```ts
export interface TokenUsageRecord {
  timestamp: string;            // ISO 8601
  provider: string;
  model: string;
  slot?: "main" | "second" | "vision"; // 追加。 未指定は "main" 扱い
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
  sessionId?: string;
}
```

記録箇所の修正:
- `agent-loop.ts:687` → `slot: "main"`（vision 呼び出し経路があれば "vision"）
- `second-llm-manager.ts:324,456` → `slot: "second"`

### 3.2 永続化レイアウト

```
~/.localllm/usage/
  ├── 2026-06.jsonl        # 月次。 record ごとに 1 行 append
  └── state.json           # { firstRecordAt, windowStartAt }
```

- `record()` で**インクリメンタルに append**（best-effort、失敗は無視）。
  旧 `flush()`（全件まとめ append）は二重書き込みになるため廃止し、append 方式へ置換。
- パスは `LOCALLLM_USAGE_DIR` で上書き可（テスト/サンドボックス用、動的解決）。
  vitest 実行中（`VITEST` 環境変数）かつ override 未指定なら**書き込みを抑止**し、
  実ユーザーデータの汚染を防ぐ（`persistenceEnabled()`）。テストは temp dir を override して全サイクル検証。
- `state.json`:
  - `firstRecordAt`: 全期間の起点（初回記録時に 1 度だけ設定）= 「いつから計測」の全期間値。
  - `windowStartAt`: 現在の計測窓の起点。`/cost reset` で `now` に更新。

## 4. 集計モジュール `src/cost/usage-store.ts`（新規）

`TokenTracker` は in-memory recorder のまま残し、永続化・読み戻し・集計を `UsageStore` に分離。

```ts
type Period = "session" | "window" | "today" | "month" | "all";
type GroupBy = "model" | "provider" | "slot";

interface UsageRow {
  key: string;            // model 名 / provider 名 / slot 名
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;        // 記録時点の estimatedCostUsd 合計
  recordCount: number;
}

interface UsageAggregate {
  period: Period;
  windowStartAt?: string;
  firstRecordAt?: string;
  rows: UsageRow[];       // groupBy で集計済み・cost 降順
  grand: UsageRow;        // 全行合計
  unpricedModels: string[]; // pricing.json に無く cost=0 のモデル
}
```

メソッド:
- `loadRecords(period)`: session=in-memory、window/today/month/all=月次 jsonl を読み窓フィルタ。
  - window: `timestamp >= windowStartAt`
  - today: 当日（ローカル日付）
  - month: 当月ファイルのみ
  - all: 全月次ファイル
- `aggregate(period, groupBy)`: 上記を読み groupBy 集計 → `UsageAggregate`。
- `reset()`: `windowStartAt = now` を state.json に書き、in-memory もクリア。
- `export(period, format)`: jsonl/csv を `~/.localllm/usage/exports/usage-export-<spec>-YYYY-MM-DD.{jsonl,csv}` に出力
  （配布 exe でも常に書込可能なホーム配下。 destDir 引数で上書き可）。

cost は**記録時点の estimatedCostUsd を信頼**（後から単価が変わっても過去コストは保持）。
ただし `/cost models` の単価列は現行 `pricing-table.ts` から引く（参考表示）。

### 4.1 プロンプトキャッシュの計上（2026-06-01 追加）

当初 `cachedTokens` は記録箇所で `0` 固定、 コスト計算もキャッシュ非考慮だったため、
共通プレフィックスを多数回再送する agent ループ（例: 49 リクエストで入力累計 250 万 tokens）
で**実 Azure 請求額より過大評価**していた（ニュース調査 2 件で $6.55 と表示、 実額はキャッシュ
ヒット分が割引されるため相当低い見込み）。修正:

- `azure-gpt.ts`: Responses API の `usage.input_tokens_details.cached_tokens` を読み、
  `ChatChunk.usage.cachedTokens` として surface（`response.completed` / `response.incomplete` 両方）。
- `agent-loop.ts` / `second-llm-manager.ts`: 固定 `0` を廃し実 `cachedTokens` を記録、
  `CostCalculator.calculateForModelWithCache` でキャッシュ割引単価を適用。
- `pricing-table.ts`: gpt-5.x に `cachedInputPerMToken`（入力の 0.1×）、 gpt-4o 系に 0.5× を追加。
  実契約と異なる場合は `~/.localllm/pricing.json` で上書き可。

`cachedTokens` は `inputTokens` の内数（キャッシュヒットした入力分）。 provider が報告しなければ
`0`＝従来どおり全額計上にフォールバックするため、 非対応 provider でも壊れない。

## 5. コマンド UX

`/cost [sub] [period]`、`/token` は alias。period 既定は `window`（現在の計測窓）。

### 5.0 期間指定 `PeriodSpec`（昨日・先月・任意日/月に対応）

期間トークンは `resolvePeriod()` で `PeriodSpec` に解決する。引数のどこに置いてもよい
（例: `/cost models yesterday` も `/cost yesterday models` も可）。

| トークン | 解決 | 意味 |
|---|---|---|
| `session` | `{type:"session"}` | 今プロセスの in-memory 分のみ |
| `window` (既定) | `{type:"window"}` | 計測窓（最後の reset 以降） |
| `all` | `{type:"all"}` | 全期間（全月次ファイル） |
| `today` / `yesterday` | `{type:"day", key:"YYYY-MM-DD"}` | 今日 / 昨日 |
| `month` / `lastmonth` (`last-month`) | `{type:"month", key:"YYYY-MM"}` | 今月 / 先月 |
| `YYYY-MM-DD` | `{type:"day", key}` | 任意の日 |
| `YYYY-MM` | `{type:"month", key}` | 任意の月 |

`loadRecords(spec)`: day=該当月ファイルを読み当日抽出、month=該当月ファイル、all=全ファイル、
window=全ファイルを `timestamp >= windowStartAt` で抽出、session=in-memory。

| 入力 | 表示 |
|---|---|
| `/cost` | サマリ: 計測窓（windowStartAt〜now、全期間 firstRecordAt も）/ grand 合計（req/in/out/cached/$）/ 上位モデル 3 件 |
| `/cost models [period]` | モデル別テーブル（model / req / in / out / cached / $ / 単価 in-out / 算出根拠）。未登録モデルは ⚠ |
| `/cost providers [period]` | provider 別 + slot 別（main/second/vision）の 2 テーブル |
| `/cost today` \| `yesterday` \| `month` \| `lastmonth` \| `all` \| `session` \| `YYYY-MM-DD` \| `YYYY-MM` | サマリを指定期間で |
| `/cost reset` | windowStartAt をリセット（履歴 jsonl は消さない。過去は `/cost all` や日付指定で参照可） |
| `/cost export [csv\|jsonl] [period]` | `~/.localllm/usage/exports/` に出力 |
| `/cost rate <円>` | 為替レート（1ドルあたりの円）を設定。以降コスト表示が **円のみ** に切り替わる |
| `/cost rate` | 現在の為替レートを表示（未設定ならドル表示中の旨） |
| `/cost rate off` | 為替レートをリセットし **ドル表示** に戻す（`reset` / `none` / `0` も同義） |

### 5.0.1 為替レート（ドル⇔円の表示切替）

- 設定値は `config.jpyPerUsd`（1ドルあたりの円。任意項目、`saveConfig` で永続化）。
- **表示はどちらか一方**。レート設定時は円のみ（`¥1,234`、`Math.round(usd * jpyPerUsd)` を桁区切り表示）、
  未設定時は従来どおりドルのみ（`$0.1234`）。両方併記はしない。整形は `cost-view.ts` の
  `fmtMoney(usd, jpyPerUsd?)` に一元化し、`/cost` 各表示とセッション終了サマリの estimated 行で共有する。
- 単価列（`単価(in/out $/M)`）は USD 据え置き。レート設定時は cost 列ヘッダのみ `cost(¥)` と明示する。

### 5.1 表示モック（`/cost models`）

```
  === Cost — モデル別 (計測窓: 2026-06-01 09:12 〜 現在) ===
  model           req    in        out      cached    cost      単価(in/out $/M)
  gpt-5.4          21    142,300    18,420   12,000    $0.6921   2.50 / 15.00
  claude-sonnet-4.6 4     8,100     2,300        0    $0.0589   3.00 / 15.00
  gemini-3-flash   2      3,200       900        0    $0.0043   0.50 / 3.00
  ─────────────────────────────────────────────────────────────
  合計             27    153,600    21,620   12,000    $0.7553
  ⚠ 単価未登録: my-local-model (cost=0 で計上)。 ~/.localllm/pricing.json に追記可
  算出: cost = in×単価in/1M + out×単価out/1M (cached は cachedInputPerMToken 適用)
```

## 6. 補完（completer.ts）

`BUILTIN_COMMAND_DEFS` に `/cost`（と `/token`）を追加。`/status` 集約の注記は残しつつ
「`/cost` は詳細表示として復活」を明記。サブコマンド（models/providers/reset/export/rate/today/
month/all/session）は `/loop` 等と同様にサブコマンド補完を実装（completer のサブコマンド機構に追従）。

## 7. 実装フェーズ

- **P1 永続化基盤**: `TokenUsageRecord.slot` 追加 + record 箇所修正 + インクリメンタル append +
  state.json（firstRecordAt/windowStartAt）。旧 flush 廃止。
- **P2 集計モジュール**: `usage-store.ts`（loadRecords/aggregate/reset/export）+ ユニットテスト。
- **P3 コマンド**: `/cost` + サブコマンド + `/token` alias を repl に実装。
- **P4 補完**: completer にコマンド + サブコマンド補完。
- **P5 整合**: `/status` の Cost 行に「詳細は /cost」 を 1 行追記（重複表示はしない）。

## 8. 非対象・リスク

- ローカルLLM（ollama 等）は cost=0 だが token は計上（参考値）。単価未登録警告で区別。
- 月をまたぐ集計（all）は全 jsonl 走査。件数が膨大化したら要約/ローテーション（将来課題）。
- 通貨は USD 固定（pricing が USD）。JPY 換算は将来課題。
- `flush()` を append 方式へ変えるため、既存の `flush()` 参照が無いことを確認済み（デッドコード）。
- 表示色は他コマンド同様 chalk 依存。最終 UX は TTY 手動確認。
