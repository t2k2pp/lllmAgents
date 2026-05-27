# Model Registry 設計書 (LLM 接続のレジストリ化)

> **ステータス**: 2026-05-27 提案 (実装前ドラフト・user レビュー待ち)
> **作成日**: 2026-05-27
> **位置付け**: 「メインLLM / セカンドLLM / プロファイル履歴 / プロバイダ別 setup コマンド」
> が並走している現状を、 **registry (登録一覧) + slot (現在の割当) の 2 層モデル** に
> 統合し直す上位設計。
>
> **関連 (本書で吸収・改訂する設計)**:
> - `docs/llm-profiles.md` — 履歴管理 (本書で **registry に昇格**)
> - `docs/main_second_swap_design.md` — `/swap` (本書では **slot 入替** として整理)
> - `docs/main-second-subagent-comparison.md` — main / second / subagent の関係 (将来の slot 拡張に影響)
> - `docs/model-setup.md` — setup wizard (本書で **/models の "Add new..." に統合**)
> - `docs/v030_second_llm_design.md` — second LLM 全体 (slot 上の "second" として位置付け)

---

## 1. 背景

### 1.1 解きたい問題

現状、 LLM 接続設定の操作面が **3 系統に分裂** している:

| 系統 | コマンド | 役割 |
|------|----------|------|
| (A) main 編集系 | `/model setup azure-*` ×9、 `/model host/port/url/provider/context/temperature/top_p/top_k/rep_penalty/description` | main LLM を 1 から構築 / 個別に編集 |
| (B) second 編集系 | `/second setup *` ×9、 `/second host/port/url/...` | second LLM を 1 から構築 / 個別に編集 (= A の鏡像) |
| (C) 履歴選択系 | `/profiles` (list/delete/help) | 過去に動いた設定を main/second に当てる |

データレイヤーでは **(C) の履歴 = `~/.localllm/llm-profiles.json`** が
**実際に動いた設定の自動アーカイブ** として既に存在する。 つまり登録の仕組みは
データ的にはほぼ揃っているが、 UI 上は 3 系統が並走し、 機能追加のたびに
コマンド木が肥大化する構造になっている。

### 1.2 観測されている問題

1. **第 1 階層メニューの肥大化** — 補完候補が 170 件超。 `/model setup azure-openai` の
   ような **プロバイダ別 setup コマンドが 9 個** トップレベルに並ぶ
2. **main / second のコマンド木が完全な鏡像** — プロバイダ追加のたびに両側を
   触る必要があり、 持続性が低い
3. **登録抽象 (registry) と編集コマンドが分断** — `/model temperature 0.8` は
   「現 main の temperature」 を変えるだけで、 登録された "そのモデルの推奨設定" と
   いう概念が無い。 同じ Sonnet を「推論用 (temp=0.2)」 と「創造用 (temp=0.8)」 で
   2 つ持つことが構造的にできない
4. **将来拡張への対応コストが高い** — 「third LLM」 「vision LLM」 「eval LLM」 「cheap LLM」
   といったスロットを足したくなったとき、 また同型のコマンド木 (`/third *`) を
   生成しないといけない設計になっている

### 1.3 ゴール

- **registry が真実の源** (single source of truth) になる
- 「現在 main / second に何が割り当たっているか」 は registry エントリへの参照に過ぎない
- 主要操作は `/models` 1 つに集約。 `/model` はステータス表示専用、 `/swap` は動詞ショートカット
- third / vision / eval などの slot 追加を **型レベルで容易に** できるようにしておく (実装は後)
- サブエージェント (= メインの分身で別コンテキストで走るエージェント) を将来カタログ化し、
  個別にモデル/スロットを紐づけ得る **余地** を残す (今は実装しない)

---

## 2. データモデル

### 2.1 二層構造: Registry + Slot

```ts
// ── 既存。 そのまま流用 ──
interface LLMEndpoint {
  providerType: SecondLLMProviderType;
  model: string;
  baseUrl?: string;
  endpoint?: string;          // Azure resource endpoint
  apiKey?: string;            // env:VAR / encrypted:... / 平文
  deploymentName?: string;
  projectId?: string;
  region?: string;
  contextWindow?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  description?: string;
}

// ── 新規 ──
interface LLMRegistryEntry {
  /** 安定 ID。 UUID v4 ベース。 設定パラメータ変更で別 ID にはならない */
  id: string;
  /** 表示名。 自動生成された初期値をユーザ編集可能 (新規) */
  name: string;
  /** 接続情報 + サンプリングパラメータ */
  endpoint: LLMEndpoint;
  /** 初回登録時刻 (ISO 8601) */
  createdAt: string;
  /** 最終利用時刻 (ISO 8601)。 並び替えに使う */
  lastUsedAt: string;
  /** 任意タグ (将来: グループ・絞り込み用) */
  tags?: string[];
}

interface LLMSlotAssignments {
  /** main slot に割り当てられた registry entry の id */
  main: string;
  /** second slot に割り当てられた registry entry の id (任意) */
  second?: string;
  /** 任意名前付きスロット。 third / vision / eval / cheap 等。 値は registry entry id */
  named?: Record<string, string>;
}

interface ModelRegistryStore {
  version: 1;
  entries: LLMRegistryEntry[];
  slots: LLMSlotAssignments;
}
```

### 2.2 ID 戦略の変更 (重要)

| | 旧 (`llm-profiles.ts`) | 新 (`model-registry.ts`) |
|---|---|---|
| ID の素 | FNV-1a hash(接続情報 signature) | UUID v4 (生成時に乱数) |
| 設定変更時 | 同じ ID のまま上書き (auto-merge) | 同じ ID のまま更新 (同上) |
| サンプリング違い | 1 エントリにまとまる (上書き) | **別エントリとして共存可能** |
| 重複検出 | ID 衝突で自動 | Add wizard 内で signature 一致を検出して **user に聞く** ("既存を更新する / 別エントリとして追加する") |

#### 移行時の ID

既存 `llm-profiles.json` の `id` (8文字 hex) は **そのまま温存**。 新規追加分のみ UUID。
両形式を許容するため `id: string` のままにする。

### 2.3 スロット拡張性

`slots.main` `slots.second` を **特権スロット (型に直書き)** にしている理由は、
既存コード (`config.mainLLM` を参照する箇所) との互換性を取りやすくするため。
`slots.named` は **任意のスロット名 → entry id の map** であり、 ここに
`vision` `eval` `third` `cheap` 等を追加できる。

将来 named slot を一級市民にする選択肢:
- 型を `slots: Record<string, string>` に一本化し、 `main` `second` も `named` の中に置く
- 当面は段階的移行のため二層構造を維持

### 2.4 サブエージェントカタログとの接続点 (将来)

サブエージェント定義 (`src/agents/builtin/*.md`) の frontmatter に
**optional フィールド** を後付け可能にしておく:

```yaml
---
name: code-reviewer
description: コード品質・セキュリティレビュー専任のサブエージェント
tools: [file_read, glob, grep, bash]
# ── 将来追加し得るフィールド (今は実装しない) ──
modelSlot: second       # この slot に居る LLM を使う
# または
modelRef: <registry-id> # この registry entry を直接指定 (slot バインドより強い)
---
```

これに合わせて `SubAgentManager` 側に「呼び出し時のモデル解決」 フックを残す。
**今回は実装しない** が、 registry に `id` (UUID) があれば `modelRef` で
名指しできる構造になる、 という点だけ確認しておく。

---

## 3. ストレージとマイグレーション

### 3.1 ファイル配置

| ファイル | 役割 | 後方互換 |
|----------|------|----------|
| `~/.localllm/model-registry.json` | 新形式の真実のソース (entries + slots) | — |
| `~/.localllm/llm-profiles.json` | 旧履歴 | **初回起動で読み込み → model-registry.json に移行 → 削除しない (rollback 用に保持)** |
| `~/.localllm/config.json` | `mainLLM` / `secondLLM` を従来通り保持 | **registry エントリの「キャッシュ済みコピー」 として残す** (= 旧コードパスが触っても壊れない) |

### 3.2 一貫性ルール

- registry のエントリが変更されたら、 slot が指している entry については
  `config.mainLLM` / `config.secondLLM` も同時に同期書込み
- 旧コードが `config.mainLLM` を直接変更した場合 (= 過渡期に存在し得る)、
  起動時に registry と diff を取って「registry を更新」 「config を上書き」
  どちらを正にするかは **registry を正** とするルールに統一
- slot 切替 (Set as main / Set as second / /swap) は registry を変更せず、
  slot の参照だけを書換える

### 3.3 起動時マイグレーション

```
1. ~/.localllm/model-registry.json が存在する? 
   → そのまま読む
2. 存在しない?
   2a. ~/.localllm/llm-profiles.json から旧 LLMProfile[] を読む
   2b. config.json の mainLLM/secondLLM が registry に居なければ新規 entry として追加
   2c. slot を以下で決定:
       - mainLLM の signature に一致する entry の id → slots.main
       - secondLLM の signature に一致する entry の id → slots.second
       - signature 一致が無ければ新規追加して slot へ
   2d. model-registry.json として永続化
```

マイグレーション中は **破壊的書き換えを行わない** (旧ファイルは消さない)。
1 リリース後に旧ファイル削除のメンテをするかどうかは別判断。

---

## 4. コマンド面

### 4.1 統合後の slash コマンド (LLM 設定領域)

| コマンド | 役割 | 状態 |
|---|---|---|
| `/model` | main + second + 他 named slot の状態を 1 画面で表示 + main slot 操作の入口 | **保持** |
| `/model second ...` | second slot のサブコマンド (旧 `/second ...` の正準形) | **Phase 4 で追加** |
| `/models` | レジストリピッカー。 すべての登録・編集・割当はここから | **新規** |
| `/swap` | main ⇔ second の slot 入替 | **保持** (1 動詞コマンドとして残す) |
| `/profiles` | (旧) 履歴ピッカー | **alias** として `/models` を呼ぶ (deprecation 注記) |
| `/second ...` | (旧) second 編集系 | **alias** として `/model second ...` を呼ぶ (deprecation 注記) |
| `/model info` | (旧) `/model` と完全に同一の重複 | **削除** (`/model` に統一) |
| `/model setup *` (×9) | (旧) プロバイダ別 setup | **補完から外す**。 `/models` の "Add new..." に統合 |
| `/model host/port/url/provider/temperature/top_p/top_k/rep_penalty/description` | (旧) main 個別編集 | **deprecated 警告**。 `/models` の Edit を推奨。 1 リリース後に削除 |
| `/second setup *` (×9)、 `/second model/url/provider/temperature/...` 等 | (旧) second 個別編集 | 同上 (補完候補から削除済み、 dispatcher 互換維持) |

合計: 170 件超 → 約 40 件削減 (補完候補ベース)。 第 1 階層メニューの肥大化を解消。

### 4.2 `/models` の UI フロー

#### 一覧表示

```
  ── Models (5 件) ──
  [main]   anthropic:claude-sonnet-4-6 @ api.anthropic.com    temp=0.2  ★
  [second] ollama:qwen3-32b @ 192.168.1.33:11434              temp=0.7
           gemini:gemini-2.5-pro                               temp=auto
           claude-cli:claude-haiku-4-5                         (sampling 既定)
           azure-foundry:Kimi-K2 @ my-resource.azure.com       temp=0.3

  ↑↓ 選択 / Enter アクション / a 追加 / d 削除 / / 絞り込み / Esc 閉じる
```

- `[main]` `[second]` タグは slot 割当を反映
- `★` は最終利用 (lastUsedAt が直近)
- 既定の並びは `lastUsedAt 降順`

#### アクションメニュー (選択して Enter)

```
  ── claude-sonnet-4-6 ──
  ❯ Set as main
    Set as second
    Edit...
    Duplicate (for variant configs)
    Delete
  Esc: 戻る
```

- **Set as main / second**: slot 参照を更新 (entry 自体は無傷)
- **Edit...**: 別ダイアログを開く (§4.3)
- **Duplicate**: 同 endpoint + 新規 UUID で複製。 temperature 違い等のバリアントを作りたい用途
- **Delete**: 確認 → entry を削除。 slot が指していた場合は警告 + slot を空に

#### Add new... (`a` キー)

provider 選択 → 既存 `setup-wizard.ts` を呼び出して endpoint を構築 → registry に追加。
**プロバイダ別の専用コマンドは廃止**、 ここで「どのプロバイダ?」 を聞く wizard 1 本に集約。

追加完了時に「main slot に当てる? / second に当てる? / 両方未割当のままにする?」 を聞く。

### 4.3 Edit ダイアログ

選択された entry の **以下を一括編集** できる:

```
  ── Edit: claude-sonnet-4-6 ──
  Name:           anthropic:claude-sonnet-4-6 @ api.anthropic.com
  Provider:       anthropic                       (変更不可。 変えるなら Duplicate or Add)
  Model:          claude-sonnet-4-6
  Endpoint:       https://api.anthropic.com       (provider による)
  API Key:        env:ANTHROPIC_API_KEY           (env/encrypted/平文)
  Context Window: 1000000
  Temperature:    0.2
  Top-p:          (未指定)
  Top-k:          (未指定)
  Rep Penalty:    (未指定)
  Description:    要件解釈と全体オーケストレーション向け。 推論精度優先。
  Tags:           []

  [Save] / [Cancel]
```

- Provider 変更は別 entry を作るべき行為なので Edit では不可。 Duplicate + Add new を促す
- Save 時:
  - registry エントリを更新
  - **当該 entry が main / second slot に居れば** `config.mainLLM` / `secondLLM` も同期書換 + provider 再接続

### 4.4 `/model` (ステータス表示)

```
  メインLLM:    anthropic:claude-sonnet-4-6 @ api.anthropic.com     temp=0.2
  セカンドLLM:  ollama:qwen3-32b @ 192.168.1.33:11434                temp=0.7
                 (有効, ctx=131072)

  ──── 追加スロット ────
  (なし)

  /models で登録一覧 / /swap で main↔second 入替
```

役割: **現在の状態を 1 画面で把握** することだけに特化。 編集機能は一切持たない。

### 4.5 `/swap`

slot.main と slot.second の id を入れ替えるだけ。 entry そのものは触らない。
両 slot の provider が再接続される。 (現状の挙動と同じ)

---

## 5. 段階的実装プラン

| Phase | 内容 | 破壊性 | 状態 |
|-------|------|--------|------|
| 1 | データ層: types 追加、 model-registry.ts 新設 (llm-profiles.ts を内部に吸収)、 起動時マイグレーション、 apply*Endpoint の配線 | 旧 API は同名 export で温存 → 表面的には無破壊 | **済 (`f8cc680`)** |
| 2 | UI: `/models` 実装。 `/profiles` は alias 化 + deprecation 注記 | 旧 `/profiles` は残るので無破壊 | **済 (`b2f244e`)** |
| 3 | コマンド整理: `/model setup *` 等を補完候補から外す。 `/model temperature` 系を deprecated 警告付きに | 補完が変わる (= 体感は変わるが機能は残る) | **済 (`67e71ee`)** |
| 4 | `/model` と `/second` の統合。 `/model second ...` を正準形とし、 `/second ...` は alias に。 `/model info` 重複削除 | 補完が変わる。 dispatcher は alias 維持で無破壊 | **済 (Phase 4)** |
| 5 (将来) | named slot の REPL 操作 (`/models slot vision <id>` 等)、 サブエージェントカタログとのバインド | 必要になったら | 構想のみ |

各 Phase で push 可能な単位。

---

## 6. オープン決定事項 (user 確認待ち)

| # | 項目 | 提案 | 代替 |
|---|------|------|------|
| Q1 | ID 戦略 | UUID v4 + Add wizard で signature 衝突時に user 確認 | 現状の FNV-1a hash 維持 (= 同 signature は自動 merge) |
| Q2 | `/profiles` の扱い | alias 温存 + deprecation 注記 (1 リリース猶予) | 即廃止 |
| Q3 | named slot を最初から型に入れる | **入れる** (`slots.named?` を optional として用意。 操作は Phase 4) | 入れない (third 等が必要になってから型を変える) |
| Q4 | Edit ダイアログでの Provider 変更 | 不可 (Duplicate + Add new に誘導) | 可 (provider 切替時に endpoint をリセット) |
| Q5 | サブエージェントとのバインド余地 | frontmatter optional フィールド (`modelSlot` / `modelRef`) を将来追加できる前提で設計のみ残す | 完全に別件として切り離す |
| Q6 | 旧 `llm-profiles.json` の削除タイミング | 1 リリース後の手動メンテ | 即削除 |

特に Q1 と Q3 が型に直接効くため、 実装に入る前に合意したい。

---

## 7. リスクと対策

| リスク | 対策 |
|--------|------|
| マイグレーション失敗で全 LLM 接続不能になる | model-registry.json 書込み前に旧ファイル温存。 registry 構築失敗時は config.json のみで起動するフォールバック経路を残す |
| Edit 中の save が provider 再接続中にコケる | save 処理は (a) registry 永続化 → (b) slot に居れば provider 再接続、 を順に行う。 (b) で失敗したら "registry は更新済み、 接続は前のまま" を user に通知 |
| /models picker の絞り込みで 100 件超を捌けない | 仮想スクロール or タグ絞り込み。 第一弾は 50 件上限の単純実装で十分 (現実的に超えにくい) |
| 旧コードが `config.mainLLM` を直接変更するパスが残っている | 起動時に registry と diff を取り、 registry を正として再書込み (§3.2) |
| sub-agent カタログとの将来統合が破綻 | 今は frontmatter optional フィールドの予約のみ。 SubAgentManager 側にも model 解決フックを残せるよう、 Phase 1 のデータ層設計を「id で参照可能」 にしておく |

---

## 8. 既存設計書との整合

| 既存 doc | 改訂方針 |
|----------|----------|
| `docs/llm-profiles.md` | 冒頭に「→ `docs/model-registry.md` に統合 (registry に昇格)」 を追記。 内容は実装が落ち着くまで参照可能なまま残す |
| `docs/main_second_swap_design.md` | 冒頭に「slot 表現への移行は `docs/model-registry.md` 参照」 を追記。 `/swap` の挙動は不変なので本文はそのまま |
| `docs/main-second-subagent-comparison.md` | サブエージェントとの将来統合点 (§2.4) を相互参照リンクで結ぶ |
| `docs/model-setup.md` | 「setup wizard は `/models` の Add new... から呼ばれる形に統合」 と注記 |
| `docs/v030_second_llm_design.md` | second LLM の概念は slot.second として継続。 構成変更は無し、 参照リンクのみ |
