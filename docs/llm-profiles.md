---
title: LLM 接続プロファイル履歴 (/profiles)
status: 2026-05-18 提案 / 同日実装 (2026-05-27 — model-registry に昇格予定)
---

> **後継設計**: `docs/model-registry.md` (2026-05-27 提案)
> 本書の「プロファイル」 は今後 **registry エントリ** として一般化される。 `/profiles`
> コマンドは `/models` の alias 扱いに移行し、 サンプリング違いを別エントリで持つ等の
> 拡張が加わる。 移行が落ち着くまで本書は参照可能なまま残す。

# LLM 接続プロファイル履歴

メイン/セカンド LLM の接続設定を `~/.localllm/llm-profiles.json` に履歴として残し、
過去に使った設定へワンタッチで戻れるようにする機能。

## 背景

プロバイダ追加 (Anthropic 直接 / Claude Code CLI / Azure 各種 / Vertex AI / ローカル)
が増えた結果、 「今は Claude Sonnet → 検証のため Ollama Qwen → 戻す」 のような
頻繁な切替が発生するようになった。 従来は `/model setup` で一からウィザードを
走らせる必要があり、 同じ情報を何度も入力する手間が大きかった。

スキル一覧 / MCP 一覧の選択 UI と同じ感覚で、 矢印キー + スペースで切り替えられる
プロファイル管理を入れる。

## データ構造

```ts
interface LLMProfile {
  id: string;          // signature の FNV-1a 32bit hex (8 文字)
  name: string;        // 自動生成 (例: "anthropic:claude-sonnet-4-6 @ api.anthropic.com")
  endpoint: LLMEndpoint;  // mainLLM/secondLLM どちらにも書き戻せる完全な endpoint
  createdAt: string;   // ISO 8601
  lastUsedAt: string;  // ISO 8601 (並び順のキー)
}
```

保存先: `~/.localllm/llm-profiles.json`

```json
{
  "profiles": [
    {
      "id": "4f754953",
      "name": "anthropic:claude-sonnet-4-6",
      "endpoint": {
        "providerType": "anthropic",
        "model": "claude-sonnet-4-6",
        "apiKey": "env:ANTHROPIC_API_KEY"
      },
      "createdAt": "2026-05-18T10:00:00.000Z",
      "lastUsedAt": "2026-05-18T15:30:00.000Z"
    }
  ]
}
```

## 重複判定 (auto-merge)

**接続情報のみ** を signature に含める方針 (ユーザ選択: 「接続情報のみで判定」)。
サンプリングパラメータ・description は signature に含まれないため、 同じサーバ・
同じモデルで temperature だけ違っても 1 プロファイルにまとまる (最新値で上書き)。

signature に含めるフィールド:

- `providerType`
- `model`
- `baseUrl` (ローカル系)
- `endpoint` (クラウド系)
- `deploymentName` (Azure)
- `projectId` / `region` (Vertex)
- `apiKey` の「種別」 のみ
  - `env:VAR_NAME` → `env:VAR_NAME` (環境変数名は signature に含める)
  - `encrypted:...` → `encrypted` (固定文字列。 暗号文は salt で変動するため値は無視)
  - 平文 → `plain` (固定)

含めないフィールド:

- `temperature` / `top_p` / `top_k` / `repetition_penalty`
- `description`
- `contextWindow`

ハッシュは FNV-1a 32bit (非暗号、 衝突確率は実用上問題なし)。

## 自動記録のタイミング

`recordLLMProfile(endpoint)` を以下のタイミングで呼ぶ:

- `REPL.applyMainLLMEndpoint()` の末尾 (= メインLLM 設定変更を実機反映した直後)
- `REPL.applySecondLLMEndpoint()` の末尾 (= セカンドLLM 設定変更を実機反映した直後)

つまりユーザは「保存」 操作を一切意識せず、 **実際に動いた設定だけが履歴に残る**。
接続テスト失敗時でも保存は走るが、 ユーザが該当 endpoint を選んだ事実は残しておきたい
ので意図的にこの設計とした。

## REPL UX

### `/profiles` 系コマンド

| コマンド          | 動作                                                         |
|-------------------|--------------------------------------------------------------|
| `/profiles`       | 履歴一覧から矢印で選択 → main/second どちらに適用するか選択 |
| `/profiles list`  | 一覧表示のみ (適用しない)                                    |
| `/profiles delete`| チェックボックスで複数選択 → 削除                            |
| `/profiles help`  | 使い方表示                                                   |

一覧には現在の main/second 設定にマッチするプロファイルに `[main]` / `[second]` タグが
付与され、 「今どれを使っているか」 が一目で分かる。

### setup フローへの統合

`/model setup`、 `/second setup`、 `/model setup anthropic|claude-cli|azure-*` の冒頭で、
履歴が **1 件以上存在し、 かつフィルタ条件にマッチ** する場合は以下のプロンプトを出す:

```
? メインLLM の設定方法を選択 (履歴 3 件):
  ❯ 履歴から選ぶ
    新規セットアップ
```

「履歴から選ぶ」 を選んだ場合は対象プロファイル一覧を表示して、 選択 →
`applyProfileTo()` で書き戻し。 「新規セットアップ」 を選んだ場合は従来の
ウィザードフローを継続。 履歴 0 件の場合はこの提示自体をスキップ。

フィルタ条件:

- `/model setup anthropic` / `claude-cli` / `azure-*` → 同じ provider のプロファイルのみ
- `/model setup` (ローカル系) → ollama / lmstudio / llamacpp / vllm のみ
- `/second setup` (引数なし、 履歴のみフォールバック) → 全プロファイル

## API (src/config/llm-profiles.ts)

```ts
recordLLMProfile(ep: LLMEndpoint): LLMProfile | undefined  // 不完全な ep は undefined
listLLMProfiles(): LLMProfile[]                            // lastUsedAt 降順
getLLMProfile(id: string): LLMProfile | undefined
findProfileBySignature(ep: LLMEndpoint): LLMProfile | undefined
deleteLLMProfile(id: string): boolean
deleteLLMProfiles(ids: string[]): number
touchProfile(id: string): void                             // lastUsedAt のみ更新
endpointSignature(ep: LLMEndpoint): string                 // dedup キー (公開)
generateProfileName(ep: LLMEndpoint): string               // 自動命名 (公開)
```

## 設計上の選択肢

| 項目                     | 採用案 (ユーザ確認済み)                                  | 代替案 |
|--------------------------|----------------------------------------------------------|--------|
| 名前付け                 | 自動生成のみ                                             | rename コマンド / 登録時に対話入力 |
| dedup 基準               | 接続情報のみ                                             | サンプリング値まで含める |
| UI                       | `/profiles` 専用 + setup 統合                            | `/model history` サブコマンド |
| ストレージ               | 専用ファイル (`~/.localllm/llm-profiles.json`)           | `config.json` 内に同居 |
| 保存タイミング           | apply*Endpoint 直後                                      | 明示的な `/profiles save` |

## 将来の拡張余地

- **rename サポート**: ユーザ自前のラベル (「自宅 ollama」 「会社 vLLM」) を付けたい
  ケースに備えて `/profiles rename <id> <new-name>` を後付け可能
- **エクスポート/インポート**: 別マシンに同じプロファイル群を持っていきたい
  → `/profiles export <path>` / `/profiles import <path>`
- **タグ/グループ**: provider 別、 用途別 (検証用 / 本番用) でグループ化
- **クラウドプロバイダ別の signature 戦略の細分化**: 例えば Vertex AI で
  プロジェクト違いを別プロファイルにしたい等の要望が出たら signature 関数を
  プロバイダ別に分岐する余地あり (現状は全プロバイダ統一)

## 既存機能との関係

- `/swap` (main ⇔ second 入替) は変わらず動く。 swap 直後に両 endpoint が
  applyXxxEndpoint されるので、 履歴の lastUsedAt も両方更新される
- `/model description` / `/second description` で description を変えても
  signature は変わらないので、 履歴上の **同じプロファイルが上書き更新** される
- credential vault との関係: 暗号化済み apiKey はそのまま保存。 履歴から復元
  する際は通常の applyXxxEndpoint 経路を通るので合言葉プロンプトが出る
