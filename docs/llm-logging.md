# LLM対話ログ設計

## 背景と問題

現状 `~/.localllm/logs/sessions/<sid>_<agent>.jsonl` には LLM の `request` と `response` の2種類しか記録されない。これが原因で:

- HTTP エラー本文 (500 等) が一切残らない (`http-client.ts:134` で throw 後、捕捉ログ無し)
- プロバイダ層のストリーム error chunk も残らない (`azure-anthropic.ts:204` で error chunk yield → `second-llm-manager.ts:137` で throw)
- 接続リトライの履歴が残らない (`agent-loop.ts:500-514`)
- ツール実行結果がログ記録されない (history にしか残らない)
- `tokensIn/tokensOut` は型上は定義されているが `agent-loop.ts:486` で渡されていないため常に undefined

「Azure Claude 4.5 が Mac で 500 を返す」のような事象を後追いするための情報が壊滅的に不足している。

## 設計原則: ログを2系統に分離する

ログには **目的が異なる2系統** がある。これを1ファイルに同居させると、片方のために情報が削られて、もう片方が困る。

| 系統 | 目的 | 内容の決まり方 | レベル概念 |
|---|---|---|---|
| **セッションJSONL** | AI が会話を **継続できる** ための状態永続化 (resume / replay) | 「次のターンを再構築できるか」で機能的に固定 | なし |
| **運用ログ** | 人間が **トレースする** (エラー調査・性能・警告) | レベルで取捨選択 | TRACE/DEBUG/INFO/WARN/ERROR |

**重要な不変条件**: 運用ログ側は壊れても作業は止まらない。逆にセッションJSONL側で必須情報が抜けると resume が壊れる。両者を独立に進化させる。

## セッションJSONL (`~/.localllm/logs/sessions/<sid>_<agent>.jsonl`)

### 必要十分な event types

「次のターンを再構築できる」ための最低限:

| type | 内容 | 必須性 |
|---|---|---|
| `request` | system + messages + tools (送信前) | ✅ 既存 |
| `response` | text + thinking + toolCalls + finishReason + tokensIn + tokensOut | ✅ 既存 (tokens 修正必要) |
| `tool_result` | toolCallId + toolName + input + output + success + durationMs | **追加必須** |

`tool_result` がないと resume 時にツール往復を再生できないため、これは仕様としてセッションJSONLに含める。

### スキーマ (TypeScript)

```typescript
interface SessionLogBase {
  ts: string;
  turn: number;
  agentId: string;
}

interface SessionRequestLog extends SessionLogBase {
  type: "request";
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
}

interface SessionResponseLog extends SessionLogBase {
  type: "response";
  model: string;
  thinking?: string;
  text?: string;
  toolCalls?: ToolCall[];
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  finishReason?: string;
}

interface SessionToolResultLog extends SessionLogBase {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: unknown;            // パース失敗時は raw string
  output: string;
  success: boolean;
  error?: string;
  durationMs: number;
}
```

### 含めないもの (運用ログの仕事)

- HTTP エラーステータス・本文
- プロバイダ層の error chunk
- 接続リトライ
- 送信ワイヤフォーマット (Anthropic 変換後の body 等)
- 内部状態のデバッグ情報

## 運用ログ (`~/.localllm/logs/ops/<sid>.jsonl`)

人間が `jq` でフィルタしながら読むことを想定し、JSONL 形式に統一。

### レベル定義

| level | 内容 | 例 |
|---|---|---|
| ERROR | 失敗・例外 | HTTP 500、stream error、未捕捉例外 |
| WARN | 異常だが継続できる | 接続リトライ、レート制限、フォールバック発動 |
| INFO | 主要イベント | ターン開始/終了、モデル切替、セッション開始/復元 |
| DEBUG | 調査用詳細 | ツール引数全文、コンテキスト圧縮の判定根拠 |
| TRACE | 全量 | 送信ワイヤ body、SSE 生チャンク |

各レベルは下位レベルを **包含する** (level=DEBUG なら DEBUG/INFO/WARN/ERROR 全部出る)。デフォルト `INFO`。

### スキーマ

```typescript
interface OpsLogEntry {
  ts: string;             // ISO timestamp
  level: "trace" | "debug" | "info" | "warn" | "error";
  agentId: string;        // "main" | "second-llm-consult" | "second-llm-agent" | sub-agent ID
  category: string;       // "http" | "stream" | "retry" | "turn" | "tool" | "session" | ...
  message: string;        // 人間可読メッセージ
  data?: Record<string, unknown>;  // 構造化詳細 (HTTP status, URL, error stack 等)
}
```

### エラーパスごとの記録ポイント

| 場所 | level | category | 内容 |
|---|---|---|---|
| `http-client.ts` `httpPostStream` 非200 | error | http | status, url, body (先頭4KB), method |
| `azure-anthropic.ts` doChat catch | error | stream | provider, url, error message, stack |
| `azure-anthropic.ts` doChat (LLM_DEBUG_HTTP) | trace | http | wire body, headers (キーマスク) |
| `parseAnthropicStream` error chunk | error | stream | error type, message |
| `agent-loop.ts` 接続リトライ | warn | retry | attempt, max, waitMs, error |
| `agent-loop.ts` ターン境界 | info | turn | iteration, msgCount, contextWindow |
| `agent-loop.ts` ツール実行 catch (parallel) | error | tool | toolName, error |
| `second-llm-manager.ts` consult catch | error | second-llm | model, error |

### 機密データの扱い

- API キー (`x-api-key` / `Authorization`) は常にマスク (`***`)
- TRACE で wire body を出すときも、Anthropic では平文だが HTTP ヘッダの認証情報はマスク
- ユーザープロンプト本文は記録 (これがないと再現不可)。ローカルファイルのみで外部送信されないことを前提

## 設定

`~/.localllm/config.json`:

```json
{
  "logging": {
    "ops": {
      "enabled": true,
      "level": "info",
      "path": "~/.localllm/logs/ops/<sid>.jsonl"
    }
  }
}
```

`<sid>` はセッション開始時に確定。path 内の `~` と `<sid>` を起動時に展開する。

### 動的変更

REPL コマンド `/loglevel [trace|debug|info|warn|error]` を追加:
- 引数なし: 現在の level を表示
- 引数あり: その level に変更 (config には保存しない、当該セッション内のみ)

## 実装範囲

### A. セッションJSONL 拡張 (`src/agent/llm-logger.ts`)
- `LLMToolResultLog` 型と `logToolResult()` メソッド追加
- 既存 `request`/`response` イベントは互換維持
- `agent-loop.ts:486` で tokensIn/tokensOut を渡す

### B. 運用ログ新設 (`src/utils/ops-logger.ts`)
- `OpsLogger` クラス: `trace/debug/info/warn/error` メソッド
- レベル比較・JSONL append
- グローバルインスタンス + `getOpsLogger()` ヘルパー (sub-agent等から共有)
- `setOpsLogLevel()` で動的変更

### C. config 拡張 (`src/config/types.ts`)
- `LoggingConfig` 型追加
- `getDefaultConfig()` にデフォルト追加 (`ops.enabled: true, ops.level: "info"`)

### D. エラーパス配線
- `http-client.ts`: 非200 throw 前に `opsLogger.error("http", ...)`
- `azure-anthropic.ts`: error chunk 生成時に `opsLogger.error("stream", ...)` 、LLM_DEBUG_HTTP 相当を TRACE 出力に統合
- `agent-loop.ts`: 接続リトライで `opsLogger.warn("retry", ...)`、ターン境界で `opsLogger.info("turn", ...)`
- `executeSingleTool` / `executeToolsParallel`: 結果を `llmLogger.logToolResult()` に記録、失敗時は `opsLogger.error("tool", ...)`
- `second-llm-manager.ts`: catch 内で `opsLogger.error("second-llm", ...)`

### E. REPL コマンド (`src/cli/repl.ts`)
- `/loglevel` を `completer.ts` と `renderer.ts` のヘルプにも追加

### F. 動作確認
- 故意に Azure エンドポイントを壊して 500 を発生させ、`~/.localllm/logs/ops/*.jsonl` に `error` 行が出ることを確認
- セッションJSONL は `tool_result` 込みで完結することを確認
- `/loglevel debug` で wire body 等が追加で出ることを確認

## 影響範囲

- 既存セッションJSONL の読み手はリポジトリ内に存在しない (確認済) → 互換性懸念なし
- 既存 console logger (`src/utils/logger.ts`) は残す。ops-logger とは独立 (前者は人間向け表示、後者はファイル永続化)
