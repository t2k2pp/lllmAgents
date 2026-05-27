# 設定リファレンス (`~/.localllm/config.json`)

初回起動時のセットアップウィザード (`npm run setup`) が最小構成を自動生成する。
以降はこのファイルを直接編集して設定を追加・変更する。

---

## 目次

1. [構成パターン例](#構成パターン例)
2. [mainLLM — メインLLM](#mainllm)
3. [サンプリングパラメータ](#サンプリングパラメータ)
4. [visionLLM — 画像認識用サブLLM](#visionllm)
5. [secondLLM — セカンドLLM委任](#secondllm)
6. [security — セキュリティ](#security)
7. [context — コンテキスト管理](#context)
8. [discord — Discord連携](#discord)
9. [slack — Slack連携](#slack)
10. [search — Web検索](#search)
11. [obsidian — Obsidianナレッジベース連携](#obsidian)
12. [その他のトップレベル設定](#その他のトップレベル設定)

---

## 構成パターン例

### パターン1: 最小構成（ローカルOllama）

セットアップウィザードが生成するデフォルト。サンプリングパラメータはサーバー側のモデル推奨値をそのまま使用。

```json
{
  "mainLLM": {
    "providerType": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "qwen3:32b",
    "contextWindow": 40000
  },
  "visionLLM": null,
  "secondLLM": null,
  "security": {
    "allowedDirectories": [],
    "autoApproveTools": ["file_read", "glob", "grep"]
  },
  "context": {
    "compressionThreshold": 0.8
  }
}
```

### パターン2: vLLM + モデル推奨サンプリング指定

モデルの公式推奨値を明示的に指定するパターン。サーバー側の `generation_config.json` と一致させる場合や、サーバー設定を上書きしたい場合に使用。

```json
{
  "mainLLM": {
    "providerType": "vllm",
    "baseUrl": "http://192.168.1.201:8000",
    "model": "gemma-3-27b-it",
    "contextWindow": 128000,
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 64
  },
  "visionLLM": null,
  "secondLLM": null,
  "security": {
    "allowedDirectories": [],
    "autoApproveTools": ["file_read", "glob", "grep", "web_search", "web_fetch"]
  },
  "context": {
    "compressionThreshold": 0.8
  }
}
```

### パターン3: vLLM + セカンドLLM (クラウド委任)

高コストなタスク（大規模コード分析等）をクラウドLLMに委任する構成。

```json
{
  "mainLLM": {
    "providerType": "vllm",
    "baseUrl": "http://192.168.1.201:8000",
    "model": "qwen3.5-27b",
    "contextWindow": 130000
  },
  "visionLLM": null,
  "secondLLM": {
    "enabled": true,
    "endpoint": {
      "providerType": "vertex-ai",
      "model": "claude-sonnet-4-20250514",
      "projectId": "my-gcp-project",
      "region": "us-east5"
    },
    "budget": {
      "limitUsd": 5.0,
      "warningThreshold": 0.8,
      "stopThreshold": 0.95
    },
    "cost": {
      "referenceModels": ["claude-sonnet-4-20250514"]
    }
  },
  "security": {
    "allowedDirectories": [],
    "autoApproveTools": ["file_read", "glob", "grep", "web_search", "web_fetch"]
  },
  "context": {
    "compressionThreshold": 0.8
  }
}
```

### パターン4: フル構成（Discord + Slack + ストリーミング表示）

全機能を有効にした構成。

```json
{
  "mainLLM": {
    "providerType": "vllm",
    "baseUrl": "http://192.168.1.201:8000",
    "model": "qwen3.5-27b",
    "contextWindow": 130000
  },
  "visionLLM": {
    "providerType": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "llava:13b",
    "contextWindow": 4096
  },
  "secondLLM": null,
  "security": {
    "allowedDirectories": [],
    "autoApproveTools": ["file_read", "glob", "grep", "web_search", "web_fetch"],
    "requireApprovalTools": ["file_write", "file_edit", "bash"],
    "rules": {
      "allow": ["bash(npm *)"],
      "deny": ["bash(rm -rf *)"],
      "ask": ["bash(git push *)"]
    }
  },
  "context": {
    "compressionThreshold": 0.8
  },
  "discord": {
    "enabled": true,
    "webhookUrl": "https://discord.com/api/webhooks/..."
  },
  "slack": {
    "enabled": true,
    "webhookUrl": "https://hooks.slack.com/services/...",
    "botToken": "xoxb-...",
    "appToken": "xapp-..."
  },
  "search": {
    "provider": "searxng",
    "searxngUrl": "http://localhost:8888"
  },
  "streamingDisplay": true,
  "maxParallelTools": 2
}
```

---

## mainLLM

メインで使用するLLMエンドポイントの設定。

| キー | 型 | 必須 | 説明 |
|------|-----|------|------|
| `providerType` | ProviderType (ローカル) または CloudProviderType | Yes | 推論サーバーの種別。 ローカル: `"ollama"` \| `"lmstudio"` \| `"llamacpp"` \| `"vllm"`。 クラウド: `"vertex-ai"` \| `"azure-openai"` \| `"azure-gpt"` \| `"azure-claude"` \| `"azure-foundry"` \| `"azure-anthropic"` \| `"anthropic"` \| `"claude-cli"` |
| `baseUrl` | string | Local Only | APIエンドポイントURL (ローカル系のみ)。 クラウド系では `endpoint` / `apiKey` を使う |
| `model` | string | Yes | モデル名（サーバーに登録されている名前） |
| `contextWindow` | number | No | コンテキストウィンドウサイズ（トークン数）。未指定時はサーバーから取得を試みる |
| `apiKey` | string | Cloud | クラウド系 (`anthropic` / `azure-*`) の認証情報。 `env:VAR_NAME` / `encrypted:...` / 平文。 `anthropic` は省略時 `env:ANTHROPIC_API_KEY` にフォールバック |
| `endpoint` | string | Azure | Azure 系のリソース endpoint (`https://...`) |
| `deploymentName` | string | Azure | Azure OpenAI / Azure Claude の deployment 名 (Foundry / Anthropic / GPT-Responses は不要) |
| `projectId`, `region` | string | Vertex | Vertex AI 用 |
| `temperature` | number | No | サンプリング温度。[後述](#サンプリングパラメータ) |
| `top_p` | number | No | Top-p (nucleus sampling)。[後述](#サンプリングパラメータ) |
| `top_k` | number | No | Top-k sampling。[後述](#サンプリングパラメータ) |
| `repetition_penalty` | number | No | 繰り返しペナルティ。[後述](#サンプリングパラメータ) |

デフォルトポート（baseUrl未指定時のフォールバック）:

| プロバイダー | ポート |
|------------|--------|
| Ollama | 11434 |
| LM Studio | 1234 |
| llama.cpp | 8080 |
| vLLM | 8000 |

## サンプリングパラメータ

`mainLLM` 内にオプションで指定する。**未指定のパラメータはAPIリクエストに含まれず、推論サーバー側のデフォルト値がそのまま使われる。**

推論サーバー側のデフォルト値は、モデルに同梱される `generation_config.json`（vLLM）や `Modelfile`（Ollama）等で定義されており、モデル作者の推奨値になっている。特別な理由がなければ指定しないのが安全。

| パラメータ | 説明 | 指定する場面 |
|-----------|------|-------------|
| `temperature` | 生成のランダム性。高いほど多様、低いほど決定的 | モデルの公式推奨値がサーバー設定と異なる場合 |
| `top_p` | 累積確率でトークン候補を制限 | 同上 |
| `top_k` | 上位k個のトークンのみ候補にする | 同上 |
| `repetition_penalty` | 同じトークンの繰り返しを抑制（1.0=無効） | 量子化モデルで反復崩壊が起きる場合に1.05〜1.1程度を指定 |

### モデル別の推奨値の例

| モデル | temperature | top_p | top_k | 出典 |
|--------|-------------|-------|-------|------|
| Gemma 3/4 | 1.0 | 0.95 | 64 | Google公式 |
| Qwen3 (thinking) | 0.6 | 0.95 | — | Qwen公式 (enable_thinking=true) |
| Qwen3 (non-thinking) | 0.7 | 0.8 | 20 | Qwen公式 (enable_thinking=false) |

推論サーバーがモデルのデフォルト値を正しく読み込んでいれば、ここで改めて指定する必要はない。`/model` コマンドで現在の設定値を確認できる（`auto` = サーバーデフォルト使用中）。

## visionLLM

画像認識用のサブLLM。メインLLMがVisionに対応していない場合、スクリーンショット分析等をこのモデルに委譲する。不要なら `null`。

| キー | 型 | 必須 | 説明 |
|------|-----|------|------|
| `providerType` | ProviderType | Yes | |
| `baseUrl` | string | Yes | |
| `model` | string | Yes | Vision対応モデル (例: `llava:13b`) |
| `contextWindow` | number | No | |

## secondLLM

メインLLMとは別のモデルにタスクを委任する機能。`/delegate` コマンドまたは `second_llm` ツールで使用。不要なら `null`。

| キー | 型 | 必須 | 説明 |
|------|-----|------|------|
| `enabled` | boolean | Yes | 機能の有効/無効 |
| `endpoint` | SecondLLMEndpoint | Yes | 接続先の設定 |
| `budget` | BudgetConfig \| null | No | クラウドLLM利用時の予算制限。ローカルLLMなら `null` |
| `cost` | CostConfig | No | コスト計算の参考モデル |

### SecondLLMEndpoint

> **注**: 2026-04-29 以降、 `SecondLLMEndpoint` は `LLMEndpoint` (mainLLM 用) と完全に同一の型エイリアス。 `description` / `temperature` / `top_p` / `top_k` / `repetition_penalty` などすべてのフィールドが両者共通。 詳細は `docs/main_second_swap_design.md` を参照。

ローカルLLMとクラウドLLMのどちらも指定可能。

**ローカルLLMの場合 (サンプリング値・特性説明込み):**
```json
{
  "providerType": "vllm",
  "model": "qwen3:8b",
  "baseUrl": "http://localhost:8001",
  "description": "軽量7B。超高速だが精度中程度。要約・grep結果絞り込み・機械的委任向き",
  "temperature": 0.2,
  "top_p": 0.9
}
```

**Vertex AI (Claude) の場合:**
```json
{
  "providerType": "vertex-ai",
  "model": "claude-sonnet-4-20250514",
  "projectId": "my-gcp-project",
  "region": "us-east5"
}
```

**Azure OpenAI の場合:**
```json
{
  "providerType": "azure-openai",
  "model": "gpt-4o",
  "endpoint": "https://my-resource.openai.azure.com",
  "apiKey": "...",
  "deploymentName": "gpt-4o-deployment"
}
```

**Anthropic API (公式) の場合:**
```json
{
  "providerType": "anthropic",
  "model": "claude-sonnet-4-6",
  "apiKey": "env:ANTHROPIC_API_KEY",
  "contextWindow": 1000000
}
```

`apiKey` を省略すると `env:ANTHROPIC_API_KEY` にフォールバックする。
利用可能モデル一覧は `docs/claude-providers.md` の CLAUDE_MODELS 表を参照。

**Claude Code CLI (`claude -p`) の場合:**
```json
{
  "providerType": "claude-cli",
  "model": "claude-sonnet-4-6",
  "contextWindow": 1000000
}
```

API キー不要 (claude CLI 側の `claude login` 済みセッションを再利用)。
ツール呼び出しは claude 内部で完結し、 lllmAgents のツールには非接続。
詳細: `docs/claude-providers.md`

### BudgetConfig

| キー | 型 | デフォルト | 説明 |
|------|-----|----------|------|
| `limitUsd` | number | — | セッションあたりの予算上限 (USD) |
| `warningThreshold` | number | 0.8 | 予算の何%で警告するか (0.0〜1.0) |
| `stopThreshold` | number | 0.95 | 予算の何%で自動停止するか (0.0〜1.0) |

## security

### 基本設定

| キー | 型 | 説明 |
|------|-----|------|
| `allowedDirectories` | string[] | アクセスを許可する追加ディレクトリ（CWDは常に許可） |
| `blockedCommands` | string[] | 実行を禁止するコマンドパターン |
| `autoApproveTools` | string[] | 確認なしで自動実行を許可するツール名 |
| `requireApprovalTools` | string[] | 実行前に必ず確認を求めるツール名 |
| `discordAutoApproveTools` | string[] | Discord経由リクエストで自動許可するツール |
| `slackAutoApproveTools` | string[] | Slack経由リクエストで自動許可するツール |
| `streamCommandOutput` | boolean | bash実行中の標準出力をリアルタイム表示するか (デフォルト: true) |

### rules — パターンベース権限ルール

ツール名リストより細かい粒度で権限を制御する。`ツール名(引数パターン)` の形式で記述し、ワイルドカード (`*`) が使える。

```json
{
  "rules": {
    "allow": ["bash(npm *)", "bash(node *)"],
    "deny": ["bash(rm -rf *)"],
    "ask": ["bash(git push *)"]
  }
}
```

評価順: deny → ask → allow → autoApproveTools/requireApprovalTools

### processSandbox — OSレベルサンドボックス

| キー | 型 | 説明 |
|------|-----|------|
| `enabled` | boolean | サンドボックスの有効/無効 (デフォルト: false) |
| `level` | `"none"` \| `"network"` \| `"full"` | 隔離レベル |

- `none`: OSレベル隔離なし
- `network`: ネットワーク名前空間隔離 (Linux: unshare --net, macOS: sandbox-exec)
- `full`: ネットワーク + ファイルシステム隔離 (Linux: bwrap, macOS: sandbox-exec)

## context

| キー | 型 | デフォルト | 説明 |
|------|-----|----------|------|
| `compressionThreshold` | number | 0.8 | コンテキスト使用率がこの値を超えたら自動圧縮 (0.0〜1.0) |
| `maxHistoryMessages` | number | 100 | 保持する最大メッセージ数 |

## discord

### Webhook通知

| キー | 型 | 説明 |
|------|-----|------|
| `enabled` | boolean | 通知の有効/無効 |
| `webhookUrl` | string | Discord Webhook URL |

CLI からは `/integrations` (短縮: `/intg`) → Discord の picker で対話設定 (canonical)。 旧 `/discord url <URL>` → `/discord enable` → `/discord test` も dispatcher 互換のため動作する。

### Slash Command受信（オプション）

| キー | 型 | 説明 |
|------|-----|------|
| `applicationId` | string | Discord Developer PortalのApplication ID |
| `publicKey` | string | Ed25519公開鍵（署名検証用） |
| `botToken` | string | Botトークン（コマンド登録・応答送信） |
| `interactionPort` | number | HTTPサーバーポート (デフォルト: 3003) |
| `listenEnabled` | boolean | 起動時にInteractionサーバーを自動起動するか |

## slack

| キー | 型 | 説明 |
|------|-----|------|
| `enabled` | boolean | Webhook通知の有効/無効 |
| `webhookUrl` | string | Incoming Webhook URL |
| `botToken` | string | `xoxb-` Bot Token (Bolt用) |
| `appToken` | string | `xapp-` App-Level Token (Socket Mode用) |

Slack Bot (`--slack` モード) を使う場合は `botToken` + `appToken` の両方が必要。
CLI からは `/integrations` → Slack の picker で対話設定 (canonical)。 旧 `/slack bot-token <TOKEN>` → `/slack app-token <TOKEN>` も dispatcher 互換で動作する。

## search

| キー | 型 | デフォルト | 説明 |
|------|-----|----------|------|
| `provider` | `"duckduckgo"` \| `"searxng"` | `"duckduckgo"` | Web検索プロバイダー |
| `searxngUrl` | string | — | SearXNGのJSON APIエンドポイント (例: `http://localhost:8888`) |

CLIコマンド `/search provider searxng` → `/search url http://localhost:8888` でも設定可能。

## obsidian — Obsidianナレッジベース連携

Obsidian Vault をナレッジベースとして使用する。設計詳細は [docs/obsidian-integration.md](obsidian-integration.md) を参照。

| キー | 型 | デフォルト | 説明 |
|------|-----|----------|------|
| `vaultPath` | string | — | Obsidian Vaultの絶対パス。`/knowledge vault <path>` で設定可能 |
| `knowledgeDir` | string | `"Knowledge"` | ナレッジノートの保存先ディレクトリ (vault相対) |
| `defaultTags` | string[] | `["lllmagents"]` | 全ノートに自動付与するタグ |

設定例:
```json
{
  "obsidian": {
    "vaultPath": "D:/Obsidian/MyVault",
    "knowledgeDir": "Knowledge",
    "defaultTags": ["lllmagents"]
  }
}
```

CLIコマンド `/knowledge vault <path>` でも設定可能。設定するとナレッジツール (`knowledge_save`, `knowledge_search`) が有効になる。

## その他のトップレベル設定

| キー | 型 | デフォルト | 説明 |
|------|-----|----------|------|
| `streamingDisplay` | boolean | false | LLM応答をリアルタイム表示するか。`false` ならスピナー+完了後Markdownレンダリング |
| `maxParallelTools` | number | 3 | ツールの最大同時実行数。vLLMのKVキャッシュやリソースに合わせて調整 |

CLIコマンド `/parallel <N>` で実行時に変更可能。

---

## データディレクトリ

| パス | 内容 |
|------|------|
| `~/.localllm/config.json` | 設定ファイル（本ドキュメント） |
| `~/.localllm/sessions/` | セッション履歴 |
| `~/.localllm/memory/MEMORY.md` | 永続メモリ |
| `~/.localllm/plans/` | プランモードの計画書 |
| `~/.localllm/hooks/` | ユーザーグローバルフック |
| `~/.localllm/rules/` | ユーザーグローバルルール |
| `~/.localllm/llm-logs/` | LLM I/Oログ (JSONL形式) |
