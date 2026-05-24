# gemini (Google AI Studio) プロバイダ設計書

Google AI Studio が提供する **Gemini API** (`generativelanguage.googleapis.com`) を
メインLLM / セカンドLLM の両方で利用可能にするためのプロバイダ設計書。

## 背景

既存の `vertex-ai` プロバイダは GCP 認証 (`gcloud auth print-access-token`) + プロジェクト ID +
リージョン指定が前提で、 個人開発者がカジュアルに Gemini を試すには敷居が高い。
Google AI Studio は API キー 1 個 (GEMINI_API_KEY) で同等のモデル群 (Gemini 2.5 Pro / Flash 等)
にアクセスできるため、 メインLLM / セカンドLLM の双方で扱える軽量プロバイダとして
別途追加する。

`anthropic` (Anthropic API 直接) ↔ `azure-anthropic` (Azure 経由 Claude) の関係と同型に、
`gemini` (AI Studio 直接) ↔ `vertex-ai` (GCP プロジェクト経由 Gemini) を並列に置く。

## エンドポイント仕様 (2026-05 現在)

Gemini API は OpenAI 互換エンドポイントを公式提供している。
本実装ではこちらを採用し、 既存 `OpenAICompatProvider` を継承して最小実装で済ませる。

```
POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
Header:  Authorization: Bearer <GEMINI_API_KEY>
         Content-Type: application/json
Body:    {
  "model": "gemini-2.5-pro",
  "messages": [...],
  "stream": true,
  "temperature": ..., "top_p": ...,
  "tools": [...],     # function calling 対応
  "max_tokens": ...   # optional (省略推奨)
}
```

- モデル一覧: `GET .../v1beta/openai/models` でも取得可能だが、 ハードコード一覧
  (`GEMINI_MODELS`) をフォールバックとして持つ。 動的取得は失敗してもよい。
- SSE 応答形式は OpenAI Chat Completions と同一 (`data: {choices:[{delta:{content}}]}`)。
  → 既存 `OpenAICompatProvider.doChat()` をそのまま使える。
- function calling (tool calling) は OpenAI 互換ルートで対応済み (2024 Q4 以降)。
- vision (image_url) も互換ルートで対応 (`supportsVision: true` をモデル単位で返す)。

## プロバイダ型定義

`CloudProviderType` に `"gemini"` を追加 (`src/config/types.ts`)。

```ts
export type CloudProviderType =
  | "vertex-ai"
  | "azure-openai"
  | "azure-gpt"
  | "azure-claude"
  | "azure-foundry"
  | "azure-anthropic"
  | "anthropic"
  | "claude-cli"
  | "claude-agent-sdk"
  | "gemini";        // ← 追加
```

- `isCloudProvider()` の判定リストにも追加。
- `PROVIDER_LABELS["gemini"] = "Google AI Studio (Gemini)"`。
- `GEMINI_MODELS` 定数を新設 (詳細は次節)。

## モデル一覧 (ハードコード)

`/model list` / `/model setup gemini` で選択肢として提示するモデル群。
動的取得が失敗してもフォールバックとして使える。

| id | label | context | output | vision | tool |
| --- | --- | --- | --- | --- | --- |
| gemini-2.5-pro | Gemini 2.5 Pro | 1,048,576 | 65,536 | ✓ | ✓ |
| gemini-2.5-flash | Gemini 2.5 Flash | 1,048,576 | 65,536 | ✓ | ✓ |
| gemini-2.5-flash-lite | Gemini 2.5 Flash Lite | 1,048,576 | 65,536 | ✓ | ✓ |
| gemini-2.0-flash | Gemini 2.0 Flash | 1,048,576 | 8,192 | ✓ | ✓ |
| gemini-2.0-flash-lite | Gemini 2.0 Flash Lite | 1,048,576 | 8,192 | ✓ | ✓ |

`GEMINI_MODELS` は `ClaudeModelEntry` と類似の構造で `{ id, label, contextWindow, supportsVision, supportsTool }`
を持つ。 設定値で上書きしたいケースは `modelCapabilities` (config.json) を使う既存の仕組みに委ねる。

## 認証 (API キー)

Anthropic と同一方針:

- 設定値 `endpoint.apiKey` を優先。 形式は `env:GEMINI_API_KEY` / `encrypted:...` / 平文。
- 設定値が無ければ自動的に `env:GEMINI_API_KEY` にフォールバック。
- 復号は既存の `CredentialVault.resolve(raw, passphrase)` に委譲。
- 失敗時のエラー文言: 「GEMINI_API_KEY が見つかりません。 `/model setup gemini` で設定するか、
  環境変数 GEMINI_API_KEY をセットしてください。」

## クラス構造

```
OpenAICompatProvider (既存)
   └── GeminiProvider (新設、src/providers/gemini.ts)
        - constructor(config: { apiKey, model })
        - protected getRequestHeaders() → { Authorization: `Bearer ${apiKey}` }
        - protected getChatUrl() → fixed: .../v1beta/openai/chat/completions
        - protected getModelsUrl() → fixed: .../v1beta/openai/models
        - listModels() → GEMINI_MODELS をベースに動的取得をマージ
        - getModelInfo(name) → GEMINI_MODELS から検索 + フォールバック
        - supportsVision(name) → GEMINI_MODELS の supportsVision を返す
```

baseUrl は `GEMINI_API_BASE = "https://generativelanguage.googleapis.com"` を固定値で渡す。
ユーザ設定の `endpoint.baseUrl` は使わない (= AI Studio 専用)。 もし Self-hosted な proxy を
通したい場合は将来のオプションとして検討 (今回は対応しない)。

## /model setup gemini フロー

`setupClaudeLLM()` (anthropic 用) を雛形に `setupGeminiLLM(target, "gemini")` を新設する。
共通項目が多いため将来的に `setupApiKeyOnlyLLM` 等に汎用化する余地はあるが、 今回は
別関数で実装してまず動くものを優先する。

ステップ:
1. プロファイル履歴があれば「履歴から選ぶ / 新規」 を提示 (`maybeOfferProfileHistory`)
2. モデル選択 (`GEMINI_MODELS` から `select`)
3. API キーの保存方法選択:
   - 環境変数参照 (`env:GEMINI_API_KEY`) — 推奨
   - パスフレーズで暗号化保存
   - 平文保存 (非推奨)
4. コンテキスト長: モデル既定値 (1M) を提示しつつ任意で短縮可
5. `config.mainLLM` または `config.secondLLM.endpoint` を更新
6. `applyMainLLMEndpoint()` / `applySecondLLMEndpoint()` で実行時反映
   (暗号化保存は再起動 + 合言葉が必要なので案内)

## /second / /model コマンドへの組み込み

- `cloudProviders` / `validProviders` 配列に `"gemini"` を追加 (`repl.ts` 内 2 箇所)
- `/model setup gemini` / `/second setup gemini` の case を追加 → `setupGeminiLLM` を呼ぶ
- ヘルプ (`/model setup` 引数なし時の案内、 `/second setup` 引数なし時の案内) に gemini 行を追加
- `completer.ts` に `/model setup gemini` / `/second setup gemini` を追加

## 動作確認手順

1. `GEMINI_API_KEY=...` を環境変数にセット
2. `npm run start` 起動 → `/model setup gemini`
3. モデルに `gemini-2.5-flash`、 保存方法に `env` を選択
4. `/connect` または起動時の testConnection が success すること
5. 「hello」 と打って応答ストリーミングが届くこと
6. ツール委任が必要なケースで `tool_calls` が正しくパースされること
   (例: `weather in tokyo` のような web_search 起動)

## 非対応 / 将来課題

- **Embeddings** や **Image generation** (`imagen-3.0` 等) は今回非対応。 Chat Completions のみ。
- **System instructions** は OpenAI 互換ルートが `role: "system"` を受け付けるので変換不要。
- **Citation / grounding** (web search 統合) は OpenAI 互換ルートでは未公開。 必要なら
  ネイティブ Gemini API (`/v1beta/models/<id>:generateContent`) を別経路で実装する余地あり。
- **動的モデル一覧の自動同期**: 当初は手動更新 (ハードコード)。 Google が新モデルを出した
  場合は `GEMINI_MODELS` を更新する PR が必要。
