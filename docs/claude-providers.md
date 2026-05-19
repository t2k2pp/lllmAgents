---
title: Claude プロバイダ (anthropic / claude-cli / claude-agent-sdk) 設計
status: 2026-05-18 提案 / 同日実装 / 2026-05-20 claude-agent-sdk 追加・claude-cli を Fail loud 化
related: docs/claude-agent-sdk-provider-design.md
---

# Claude プロバイダ - 公式 Anthropic API / Claude Code CLI / Claude Agent SDK

## 背景

セカンドLLM やメインLLM として **Anthropic Claude** を直接使いたいケースが増えた。
従来 Claude を使うルートは以下の 3 つに限られていた:

1. `azure-claude` (Chat Completions ラップ) — Azure OpenAI Service 経由、 OpenAI API シム
2. `azure-anthropic` (Messages API ネイティブ) — Azure 上の Anthropic エンドポイント
3. `vertex-ai` (GCP) — Vertex AI 上の Claude

これらはいずれも **クラウドベンダー (Azure / GCP) 経由** で、 個人開発者が
気軽に試すには敷居が高い。 そこで:

- **`anthropic`** — `api.anthropic.com` を直接叩く (個人 API キーで OK)
- **`claude-cli`** — ローカルにインストール済みの `claude` CLI を `-p` でサブプロセス起動
  (subscription / oauth セッションをそのまま流用、 API キー不要、 **tool calling 不可**)
- **`claude-agent-sdk`** (2026-05-20 追加) — `@anthropic-ai/claude-agent-sdk` を
  **in-process** で使う (subscription 継承で API キー不要、 in-process MCP で **tool calling 対応**)

の 3 系統を追加する。 メインLLM / セカンドLLM 両方で使えるよう、 `LLMEndpoint` の
`CloudProviderType` に追加する。

## providerType 比較

| providerType    | 認証                                              | エンドポイント                          | ツール呼び出し | 用途                              |
|-----------------|---------------------------------------------------|------------------------------------------|----------------|-----------------------------------|
| `anthropic`     | `ANTHROPIC_API_KEY` (env / encrypted / 平文)      | `https://api.anthropic.com/v1/messages`  | ◯ (ネイティブ) | API キーを持つ開発者向け           |
| `claude-cli`    | 不要 (`claude login` 済みの subscription を再利用) | サブプロセス (`claude -p ...`)           | **✕ Fail loud** (tools 渡されたら明示 error) — text 生成専用 | テキスト生成のみで OK のサブスクユーザー |
| **`claude-agent-sdk`** | 不要 (`claude login` 済みの subscription を継承) | **in-process** (`@anthropic-ai/claude-agent-sdk`) | **◯ (in-process MCP)** lllmAgent ツールを SDK の MCP として公開 | tool 委任もしたいサブスクユーザー |
| `azure-anthropic` | Azure API key                                    | `https://<resource>.azure.com/anthropic/v1/messages` | ◯              | Azure 利用組織                    |
| `vertex-ai`     | GCP ADC                                           | `aiplatform.googleapis.com`              | ◯              | GCP 利用組織                       |

## `anthropic` プロバイダの実装

`AzureAnthropicProvider` がすでに Messages API の SSE 解析 / OpenAI 形式 ↔ Anthropic 形式
変換ロジックを完備しているため、 これを継承して **最小差分** で実装する。

差分は:

- エンドポイントパスを `/anthropic/v1/messages` (Azure) → `/v1/messages` (公式) に切替
- `baseUrl` を `https://api.anthropic.com` 固定
- `listModels()` / `getModelInfo()` を `CLAUDE_MODELS` ハードコード一覧から返す
- 認証ヘッダ (`x-api-key`) は親クラスと同一仕様 — そのまま流用

親クラス側に以下のリファクタを入れた:

- `private chatUrl()` → `protected chatUrl()`
- 新規 `protected getMessagesPath()` を導入 (Azure 版は `/anthropic/v1/messages`、
  公式版は `/v1/messages` を返す)
- `private config` / `baseUrl` / `headers()` → `protected` に格上げ

### モデル一覧 (ハードコード)

`api.anthropic.com/v1/models` は存在するが、 `claude-cli` でも同じ一覧を使えるよう
動的取得ではなく **ハードコード** を採用 (CLAUDE_MODELS):

| id                    | label                          | contextWindow | cliAlias |
|-----------------------|--------------------------------|---------------|----------|
| `claude-opus-4-7`     | Claude Opus 4.7                | 200,000       | `opus`   |
| `claude-opus-4-7[1m]` | Claude Opus 4.7 (1M context)   | 1,000,000     | (なし)   |
| `claude-sonnet-4-6`   | Claude Sonnet 4.6              | 1,000,000     | `sonnet` |
| `claude-haiku-4-5`    | Claude Haiku 4.5               | 200,000       | `haiku`  |

新モデルが出たら `src/config/types.ts` の `CLAUDE_MODELS` に追記するだけで両プロバイダに反映される。

### 認証

```jsonc
// config.json (mainLLM 例)
{
  "providerType": "anthropic",
  "model": "claude-sonnet-4-6",
  "apiKey": "env:ANTHROPIC_API_KEY"   // または "encrypted:..." / 平文
}
```

`apiKey` 未指定なら `env:ANTHROPIC_API_KEY` にフォールバック (factory 側で実装)。
平文/暗号化保存も `azure-*` と同じ `CredentialVault` で復号する。

## `claude-cli` プロバイダの実装

`spawn("claude", ["-p", "--output-format", "stream-json", "--verbose", "--model", <id>])`
でサブプロセスを立ち上げ、 stdin にプロンプトを書いて stdout の line-delimited JSON を読む。

### stream-json イベント仕様 (実測)

`claude -p --output-format stream-json --verbose` の出力は 1 行 = 1 JSON object:

```
{"type":"system","subtype":"init", "tools":[...], "model":"claude-opus-4-7[1m]", ...}
{"type":"rate_limit_event", "rate_limit_info": {...}}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}],"usage":{...}}}
{"type":"result","subtype":"success","result":"...","stop_reason":"end_turn","usage":{...}}
```

本実装は:

- `assistant` イベントの content[].text を text chunk として yield
- `result` イベントから usage (input_tokens / output_tokens / cache_read_input_tokens) と
  stop_reason を抽出し、 `done` chunk として yield
- `system` / `rate_limit_event` / `user` (tool_result) は無視

### messages の flatten

claude `-p` は最後の引数 (または stdin) を「単一のプロンプト」 として受け取る設計のため、
lllmAgents の messages[] (system / user / assistant / tool) を以下のフォーマットで
1 本のテキストに連結する:

```
SYSTEM:
<system message body>

USER:
<user message>

ASSISTANT:
<assistant message>

TOOL_RESULT (id=...):
<tool result>
```

これで claude は会話履歴つきプロンプトとして解釈してくれる (履歴の役割表記は
claude の `Bash` / `Read` などの実行履歴とは別の意味なので衝突しない)。

### ツール呼び出しの扱い

claude `-p` には外部 tool 定義を注入する経路が無いため、 **lllmAgents の tool calling は
非対応** (`supportsFunctionCalling: false`)。 過去はサイレントに tools を捨てる実装だったが、
2026-05-20 に **Fail loud 修正** を入れた:

- `chatWithTools` に `tools` が渡されたら ChatChunk `type:"error"` で明示中断
- エラーメッセージで `anthropic` / `claude-agent-sdk` プロバイダへの切替を案内
- 詳細: `docs/claude-agent-sdk-provider-design.md` §1.2 / §4

`-p` モード自体の制約 (issue [anthropics/claude-code#26364](https://github.com/anthropics/claude-code/issues/26364)
で MCP も `mcp_servers:[]` になり、 Anthropic は close as "not planned") のため、 CLI 経由で
tool 橋渡しを成立させる道は事実上塞がれている。 同等の用途は `claude-agent-sdk` プロバイダで実現する。

純粋なテキスト生成器として使う場合 (= tools 無しで対話するだけ) は従来通り動作する。

### 認証

`claude` CLI 側の subscription / oauth セッション (`claude login` で取得) をそのまま使う。
lllmAgents の config には API キーを持たない (= 個人 subscription をそのまま流用できる)。
未ログインの場合は別ターミナルで `claude login` を実行するよう案内。

## REPL UX

| コマンド                              | 動作                                             |
|---------------------------------------|--------------------------------------------------|
| `/model setup anthropic`              | API キー保管方法 (env / encrypted / 平文) → モデル選択 |
| `/model setup claude-cli`             | モデル選択のみ (認証は claude CLI 側) ※tool calling 不可 |
| `/model setup claude-agent-sdk`       | モデル選択のみ (認証は claude login 継承) ※tool calling 対応 |
| `/model list`                         | CLAUDE_MODELS を選択肢として表示                 |
| `/model <id>`                         | モデル ID を直接指定 (例: `/model claude-haiku-4-5`) |
| `/second setup anthropic`             | セカンドLLM として anthropic を設定              |
| `/second setup claude-cli`            | セカンドLLM として claude-cli を設定             |
| `/second setup claude-agent-sdk`      | セカンドLLM として claude-agent-sdk を設定 (subscription + tool 両立) |
| `/swap`                               | メインLLM ⇔ セカンドLLM の入れ替え (Claude プロバイダ含む) |

REPL 側の実装は `setupClaudeLLM(target, provider)` (cli/repl.ts) に集約。
`setupAzureLLM` の API キー保管フローを簡略化したものを再利用。

## ファイル構成

```
src/
├── providers/
│   ├── anthropic.ts            # api.anthropic.com 用 (AzureAnthropicProvider 継承)
│   ├── claude-cli.ts           # claude -p サブプロセス用 (Fail loud で tool calling 拒否)
│   ├── claude-agent-sdk.ts     # 新規 2026-05-20: in-process SDK 経由 (tool calling 対応)
│   ├── azure-anthropic.ts      # 既存: 一部 private → protected に格上げ
│   └── provider-factory.ts     # 既存: case anthropic / claude-cli / claude-agent-sdk
├── tools/
│   └── sdk-mcp-bridge.ts       # 新規 2026-05-20: ToolHandler → SDK MCP tool アダプタ
└── config/
    └── types.ts                # 既存: CloudProviderType に追加、 CLAUDE_MODELS 定数を export
```

## 後方互換

破壊変更なし。 既存の `azure-anthropic` / `azure-claude` / `vertex-ai` などはそのまま動く。
`AzureAnthropicProvider` の private → protected 格上げは内部 API のみで外部に影響なし。

## 今後の拡張余地

- ~~**claude-cli のツール橋渡し**~~ → **`claude-agent-sdk` プロバイダで実装済み** (2026-05-20)。
  CLI の `-p` モード制約 (#26364 で MCP 不可) を回避し、 SDK の in-process MCP server で
  lllmAgent ツールを公開する形に着地。 詳細: `docs/claude-agent-sdk-provider-design.md`
- **動的モデル一覧**: `https://api.anthropic.com/v1/models` を叩いて CLAUDE_MODELS を
  上書きする (失敗時は CLAUDE_MODELS にフォールバック)。 alias 解決を維持するため
  まずは静的でも十分
- **長文プロンプト時の stdin パイプ最適化**: 現状 1 回 write して end しているが、
  超長プロンプト (1M token) で stdin バッファが詰まる場合 chunked write に変更
