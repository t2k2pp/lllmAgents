# UX透明性改善 + サンプリングパラメータ設計書

> **実装状況**: 完了 (2026-04-12)

## 背景・課題

### 課題1: ブラックボックスUI

エージェント処理中の画面表示が不透明で、ユーザーが「何が起きているか」を把握できない。

実際の表示例:
```
√   LLM応答開始 (1:33)
√   file_write
×   bash: Exit code: 49
√   LLM応答開始 (2:05)
/   LLM処理中... (0:41)
```

問題点:
- ツール名しか出ない（どのファイル？何のコマンド？）
- エラー時にexit codeのみ（stderrの内容が見えない）
- LLM待機中に文脈サイズが不明（いつ終わるか予測不能）
- 空レスポンスリトライの理由が不明

### 課題2: サンプリングパラメータのハードコード

- `temperature: 0.7` と `repetition_penalty: 1.05` がコードにハードコードされていた
- モデル固有の推奨値（例: Gemma4 → temperature=1.0, top_p=0.95, top_k=64）を上書きしてしまう
- `top_p` / `top_k` は型定義にすら存在しなかった
- 設定ファイルに `temperature` 欄はあったが実際のAPI呼び出しでは使われず、`?? 0.7` フォールバックが常に適用されていた

## 設計方針

### 方針1: ツールサマリの可視化

`toolCall.function.arguments` (JSON) を解析して主要引数を1行サマリにする。
追加のLLM呼び出しや外部I/Oは一切行わない（メモリ上の文字列操作のみ）。

改善後の表示イメージ:
```
√   file_write(src/cli/tool-summary.ts, 4.2KB)
√   bash(npm run build)
√   file_read(src/agent/agent-loop.ts @100 ×50)
×   bash(python script.py): Exit code: 1 — ModuleNotFoundError: No module named 'foo'
√   exit_plan_mode("Phase 1: 既存コードの調査…")
/   LLM処理中... (0:41 · 37msg · ~14.2K/128K)
√   LLM応答開始 (2:05 · 37msg · ~14.2K/128K)
```

### 方針2: サンプリングパラメータ — 「あれば送る、なければ送らない」

- vLLM / Ollama / LM Studio / llama.cpp はそれぞれモデルの `generation_config.json` や Modelfile に基づいた推奨デフォルトを持つ
- アプリ側でハードコードすると、そのモデル固有の推奨値を潰してしまう
- 正しいアプローチ: **ユーザーが明示的に設定した値のみAPIリクエストに含める。未設定ならフィールド自体を送らず、サーバー側デフォルトに委ねる**

## 実装

### 1. ツール表示サマリ (`src/cli/tool-summary.ts` 新規作成)

2つの純粋関数:

- `formatToolCall(toolCall: ToolCall): string`
  - `toolCall.function.arguments` をJSON.parseして、ツールごとに主要引数を抽出
  - パスはCWD相対に短縮、長い文字列は70文字で省略 (`…`)
  - 対応ツール: file_write, file_read, file_edit, bash, glob, grep, web_fetch, web_search, exit_plan_mode
  - 未知のツールは文字列型の最初の引数を自動表示
  
- `formatToolError(errorMsg, output): string`
  - `result.error` に加えて `result.output`（stderr含む）の末尾4行を ` ⏎ ` 区切りで併記
  - 重複排除（errorMsgに既に含まれる行は除外）

### 2. LLM待機スピナーの文脈情報 (`agent-loop.ts`)

- 待機中: `LLM処理中... (0:41 · 37msg · ~14.2K/128K)`
  - `37msg` = `this.history.getMessages().length`
  - `~14.2K/128K` = 前ターンのpromptTokens / contextWindow
- 受信中: `受信中... (1243 tok, 28 tok/s)`
  - 既存の `receivedTokens` に加え、最初のテキストチャンク受信時刻から tok/s を算出
- `lastPromptTokens` インスタンスフィールドで前ターンのpromptTokens値をキャッシュ

### 3. 空レスポンスリトライの理由表示

変更前: `空のレスポンスを受信したため再試行します (2/3)...`

変更後: `空のレスポンス (思考2451文字のみで本文なし) — 再試行します (2/3)...`

理由の分類:
- `finishReason === "length"` → `max_tokens到達で本文なし`
- `thinkingContent.length > 0` → `思考N文字のみで本文なし`
- その他 → `本文・思考ともに空`

### 4. サンプリングパラメータ

#### 型定義 (`config/types.ts`)

```typescript
export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
}

export interface LLMEndpoint extends SamplingParams {
  providerType: ProviderType;
  baseUrl: string;
  model: string;
  contextWindow?: number;
}
```

#### APIリクエスト構築 (`providers/openai-compat.ts`)

```typescript
// 変更前 (ハードコード)
temperature: temperature ?? 0.7,
repetition_penalty: 1.05,

// 変更後 (あれば送る、なければ送らない)
if (params.temperature !== undefined) body.temperature = params.temperature;
if (params.top_p !== undefined) body.top_p = params.top_p;
if (params.top_k !== undefined) body.top_k = params.top_k;
if (params.repetition_penalty !== undefined) body.repetition_penalty = params.repetition_penalty;
```

#### データフロー

```
config.json → index.ts → AgentLoop(samplingParams) → provider.chat({...samplingParams}) → doChat(params) → HTTP body
```

#### 設定ファイル例

```json
{
  "mainLLM": {
    "providerType": "vllm",
    "baseUrl": "http://192.168.1.201:8000",
    "model": "gemma4-27b",
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 64
  }
}
```

未設定の場合:
```json
{
  "mainLLM": {
    "providerType": "vllm",
    "baseUrl": "http://192.168.1.201:8000",
    "model": "gemma4-27b"
  }
}
```
→ temperature, top_p, top_k, repetition_penalty はAPIリクエストに含まれない → サーバー側がモデルの推奨値を使用

#### `/model` コマンド表示

```
── モデル情報 ──
  モデル:         gemma4-27b
  プロバイダー:   vllm @ http://192.168.1.201:8000
  コンテキスト長: 128K トークン (設定値)
  temperature:    1.0
  top_p:          0.95
  top_k:          64
  rep_penalty:    auto
```

未設定パラメータは `auto` と表示（サーバーデフォルト使用中であることを明示）。

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/cli/tool-summary.ts` | **新規** — formatToolCall, formatToolError |
| `src/agent/agent-loop.ts` | スピナー表示にサマリ・文脈情報・tok/s・リトライ理由追加。samplingParams注入 |
| `src/config/types.ts` | SamplingParams型追加、LLMEndpoint拡張、デフォルトtemperature削除 |
| `src/providers/base-provider.ts` | ChatParamsにtop_p/top_k/repetition_penalty追加 |
| `src/providers/openai-compat.ts` | ハードコード値削除、undefined時はフィールド送信しない方式に |
| `src/index.ts` | 設定値からsamplingParamsを構築してAgentLoopに渡す |
| `src/cli/repl.ts` | /modelコマンドで4パラメータ全表示 |
| `src/config/setup-wizard.ts` | デフォルトtemperature削除 |

## 性能影響

- ツールサマリ: JSON.parse 1回 + 文字列整形 (μsオーダー)。追加のLLM/ネットワーク/ファイルI/Oなし
- サンプリングパラメータ: HTTPボディのフィールド数が0〜4個変わるだけ。性能影響ゼロ
- `lastPromptTokens`: number型1個のメモリ増

## 注意事項

- `context-manager.ts` の圧縮用 `temperature: 0.3` は用途が明確（要約タスクに低温度）なので変更していない
- `second-llm-manager.ts` の `temperature: 0.2` も同様に意図的な設定なので変更していない
- `vision.ts` の `temperature: 0.3` も同様
