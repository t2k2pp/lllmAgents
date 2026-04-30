# azure-gpt プロバイダ設計書

Azure OpenAI の **Responses API** ネイティブ対応プロバイダ。

## 背景

`gpt-5-codex` / `gpt-5.1-codex-*` / `gpt-5.2-codex` / `gpt-5.3-codex` などの Codex 系および
最新 GPT-5 系モデルは、Azure OpenAI 上では **Responses API** (`/openai/v1/responses`)
経由でのみ呼び出すよう推奨されている (Microsoft 公式 Codex CLI 設定でも `wire_api = "responses"`
が明示されている)。既存 `azure-openai` プロバイダは Chat Completions API 専用で、
Responses API には対応できない。

`azure-claude` (Chat Completions ラップ) ↔ `azure-anthropic` (Messages API ネイティブ) の関係と
同型に、`azure-openai` (Chat Completions) ↔ **`azure-gpt`** (Responses API) を分離する。

## エンドポイント仕様 (2026-04 現在)

```
POST {endpoint}/openai/v1/responses
Header:  api-key: <KEY>            # または Authorization: Bearer <Entra ID token>
         Content-Type: application/json
Body:    {
  "model": "gpt-5.3-codex",
  "input": <string | message[]>,
  "max_output_tokens": <number>,
  "stream": true,
  "tools": [ ... ],                # optional
  "instructions": "...",           # optional, system 相当
  "temperature": ..., "top_p": ... # optional
}
```

- `endpoint` は `https://<resource>.openai.azure.com` / `https://<resource>.cognitiveservices.azure.com`
  どちらでも可。完全URLを貼られたら `protocol+host` だけに正規化する (`azure-anthropic` と同様)。
- v1 形式では **`?api-version=` クエリは不要**。レガシー形 (`?api-version=2025-04-01-preview`) は
  本実装ではサポートしない (新設なので最新形に統一)。
- `input` は OpenAI 形式の `messages` 配列 (`role` + `content`) をそのまま渡す形でも、
  単一文字列でも可。本実装は ChatParams.messages を Responses API の `input` 配列に変換する。
- `system` ロールは Responses API では `instructions` トップレベルに分離するのが推奨だが、
  `input` 内に `role: "developer"` または `role: "system"` として残しても受け付けられる。
  本実装は **system → instructions に集約** する (`azure-anthropic` と同じ方針)。
- `max_tokens` ではなく **`max_output_tokens`**。

## SSE イベント (Responses API)

Chat Completions の `data: {choices:[{delta:{content}}]}` ではなく、named event 形式:

```
event: response.created
data: {"type":"response.created","response":{...}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hel"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"lo"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","item_id":"call_abc","delta":"{\"x\":"}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_abc","name":"my_tool",...}}

event: response.completed
data: {"type":"response.completed","response":{"usage":{...},"status":"completed"}}
```

主要イベント:
| イベント | 役割 | パース動作 |
|---|---|---|
| `response.created` | 開始通知 | 何もしない |
| `response.output_item.added` (type=function_call) | tool 呼び出しの宣言 (id/name) | `partial[item_id] = {id, name, args:""}` を確保 |
| `response.output_text.delta` | text 増分 | `yield {type:"text", text:delta}` |
| `response.output_text.done` | text ブロック終了 | 何もしない |
| `response.function_call_arguments.delta` | tool 引数 JSON の増分 | `partial[item_id].args += delta` |
| `response.function_call_arguments.done` | tool 引数完成 | tool_call として yield |
| `response.reasoning.delta` (将来) | reasoning content (codex/o系) | `yield {type:"thinking", text:delta}` |
| `response.completed` | 完了 + usage | `yield {type:"done", usage:{...}}` |
| `response.failed` / `error` | エラー | `yield {type:"error", error:...}` |

## ツール形式

Chat Completions:
```json
{
  "type": "function",
  "function": { "name": "...", "description": "...", "parameters": {...} }
}
```

Responses API (フラット):
```json
{
  "type": "function",
  "name": "...",
  "description": "...",
  "parameters": {...}
}
```

入力 (`tools`) は `azure-anthropic` の Anthropic 形式変換と同様、`tools[].function.{name,description,parameters}`
→ `tools[].{type:"function",name,description,parameters}` に展開する。

ツール結果 (`role: "tool"`) は Responses API では `input` 内に
`{"type": "function_call_output", "call_id": "...", "output": "..."}` として表現する。

ツール呼び出し履歴 (assistant の `tool_calls`) は
`{"type": "function_call", "call_id": "...", "name": "...", "arguments": "..."}` に展開。

## 実装方針

- `LLMProvider` を直接 implement (azure-anthropic と同型)。`OpenAICompatProvider` は継承しない。
- ファイル: `src/providers/azure-gpt.ts`
- クラス: `AzureGPTProvider`
- providerType: `"azure-gpt"`
- `normalizeEndpoint(input)` static (host 部のみに正規化)
- `chat()` / `chatWithTools()` / `chatWithVision()` はすべて内部 `doChat()` に委譲
- `parseResponsesStream()` で SSE を `ChatChunk` に変換
- `listModels()` は固定で `[{name: this.config.model, ...}]` を返す (Responses API 自体には モデル一覧 GET がない)

## 設定 / config.json

`LLMEndpoint` の既存フィールドで足りる:
- `providerType: "azure-gpt"`
- `endpoint`: リソース base URL
- `apiKey`: 暗号化 / env: / 平文
- `model`: モデル ID (例 `gpt-5.3-codex`)
- `deploymentName`: **不要** (Responses API は body の `model` でルーティングする)

## REPL 操作

`/model setup azure-gpt`, `/second setup azure-gpt` を追加。`setupAzureLLM` の
`skipDeployment` ブランチに含める (deployment 入力をスキップ、model 名は必須)。

endpoint hint: `例: https://your-resource.openai.azure.com  (完全URLを貼っても可)`
modelHint: `Model 名 (例: gpt-5.3-codex):`

## 互換性

- 既存 `azure-openai` (Chat Completions) はそのまま残す。Chat Completions のみ提供のテナント、
  または旧 GPT-3.5/4 系デプロイを使うユーザーのため。
- 既存設定への影響なし (新規 providerType 追加のみ)。

## endpoint URL 正規化 (全 Azure プロバイダ共通、 2026-04-30 統一)

Azure ポータルから貼り付けた URL は `https://<resource>.openai.azure.com/openai/deployments/foo/chat/completions?api-version=...`
のように path / query が付いてくることが多い。 これを各プロバイダの URL 構築ロジックに渡すと
`{endpoint}/openai/deployments/...` を後ろに連結する際に二重 path / 不正な URL になり 404 を引く。

**対策**: 全 Azure プロバイダで `static normalizeEndpoint(input)` を提供し、 入力を必ず
`protocol://host` だけに正規化する (path / query / fragment / 末尾スラッシュは全て破棄)。

| プロバイダ | normalizeEndpoint | コンストラクタで適用 |
|---|---|---|
| azure-anthropic  | ✅ (元から) | ✅ |
| azure-foundry    | ✅ (元から) | ✅ |
| azure-gpt        | ✅          | ✅ |
| azure-openai     | ✅ (2026-04-30 追加) | ✅ |
| azure-claude     | ✅ (2026-04-30 追加) | ✅ |

REPL の `/model setup azure-*` / `/second setup azure-*` でも保存前に正規化する
(`src/cli/repl.ts:setupAzureLLM`)。 既存の config.json に古い完全URLが残っていても、
プロバイダ初期化時に再正規化されるので動作する。
