---
title: claude-agent-sdk プロバイダ設計 + claude-cli の Fail loud 修正
status: 2026-05-19 提案 (実装前)
related: docs/claude-providers.md
---

# Claude Agent SDK プロバイダ設計

## 1. 背景 — なぜ新プロバイダが要るか

### 1.1 現状の Claude 系プロバイダ

| プロバイダ | 認証 | ツール呼び出し | 問題 |
|---|---|---|---|
| `anthropic` | API キー要 | ◯ ネイティブ | コストが個人持ち |
| `claude-cli` | `claude login` 済み subscription を再利用 (API キー不要) | **✕ サイレントに捨てる** | 後述の負債 |
| `azure-anthropic` | Azure API key | ◯ | 法人組織向け |
| `vertex-ai` | GCP ADC | ◯ | 法人組織向け |

### 1.2 `claude-cli` の致命傷

`src/providers/claude-cli.ts:99-102`

```ts
async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
  // tool calling は claude 内部で完結するため、 lllmAgents 側の tool 定義は無視する
  yield* this.doChat(params);
}
```

- agent-loop は `tools: toolDefs` を渡す（ログにも記録される）
- claude-cli プロバイダは **黙ってドロップ** → claude CLI には届かない
- spawn された claude は自分のネイティブツール (Read/Write/Bash/Agent) で作業
- system-prompt は「`second_llm_agent` を使え」と言うのに、手段が無い
- LLM は混乱なく正直に「そんなツール無い」と答える ← 認知は正しい

**問題はサイレント degrade**。`supportsFunctionCalling: false` と分かっているのにエラーを出さず動いてしまう。発見コストが高い壊れ方。

### 1.3 `claude -p --mcp-config` での救済は不可

外部 MCP server 経由でツールを届ける案は技術的に成立しない:

- GitHub Issue [anthropics/claude-code#26364](https://github.com/anthropics/claude-code/issues/26364)
  - `-p / --print / --output-format stream-json` モードで MCP server が `mcp_servers:[]` になる既知バグ
  - Anthropic は **closed as "not planned"** （修正予定なし）
- `--mcp-config` で明示的に渡したローカル MCP server も同じく影響を受ける
- インタラクティブ TTY モードなら動くが、lllmAgent は spawn ベースなので使えない

→ **claude CLI 経由でツールを使うルートは塞がれている**

### 1.4 解 — Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` (旧 Claude Code SDK、2025年9月リネーム)

- **in-process MCP server** をサポート — subprocess を spawn せず、lllmAgent と同じ Node プロセス内で tool 呼び出しが完結
- `claude login` 済み subscription を継承 → **API キー不要**
- `query()` が `AsyncIterable<SDKMessage>` を返すので既存 agent-loop に統合可能
- `createSdkMcpServer()` + `tool()` で既存 ToolHandler をラップして渡せる

「claude-cli の認証メリット」と「anthropic のツール呼び出し」**両取り**できる。

## 2. アーキテクチャ

### 2.1 プロバイダ層の構造

```
[ lllmAgent agent-loop (Node process A) ]
        │
        │ provider.chatWithTools({ messages, tools })
        ▼
[ ClaudeAgentSdkProvider (同 Node プロセス A) ]
        │ SDK の query() を呼ぶ:
        │   query({
        │     prompt: <messages flatten>,
        │     options: {
        │       tools: [],                    ← built-in 全消去
        │       mcpServers: { lllmagents: <createSdkMcpServer 結果> },
        │       allowedTools: ["mcp__lllmagents__*"]
        │     }
        │   })
        ▼
[ Claude Agent SDK (同 Node プロセス A) ]
        │ ─── tool_use ───►  createSdkMcpServer の handler (同プロセス A)
        │                          │
        │                          ▼
        │                  lllmAgent の ToolExecutor.execute()
        │                          │  ┌─ file_read / file_write / bash
        │                          ▼  ├─ second_llm_agent ─► llamacpp / azure-gpt
        │                  ToolResult ┘
        │ ◄── content array ───────
        ▼
   次の tool_use または text 出力 ─► agent-loop に ChatChunk として yield
```

**全プロセスが 1 つの Node プロセス内**。subprocess なし、stdio パイプなし、JSON 文字列パースなし。

### 2.2 既存プロバイダとの位置づけ

| プロバイダ | 認証 | ツール | 用途 |
|---|---|---|---|
| `anthropic` | API キー | ◯ ネイティブ | 開発者の API キー使用時 |
| `claude-cli` | subscription | **△ Fail loud に修正** (本書 §4) | text-only 用途のみ |
| **`claude-agent-sdk` (新)** | subscription | **◯ in-process MCP** | subscription + ツール両立 |
| `azure-anthropic` / `vertex-ai` | クラウド | ◯ | 既存通り |

## 3. 新プロバイダ `claude-agent-sdk` の実装

### 3.1 ファイル構成

```
src/
├── providers/
│   ├── claude-agent-sdk.ts   ← 新規: SDK ラッパー
│   ├── claude-cli.ts          ← Fail loud 修正
│   └── provider-factory.ts    ← case "claude-agent-sdk" を追加
├── tools/
│   └── sdk-mcp-bridge.ts      ← 新規: ToolHandler → SDK tool 変換
└── config/
    └── types.ts               ← CloudProviderType に "claude-agent-sdk" 追加
```

### 3.2 `ClaudeAgentSdkProvider` の骨子

```ts
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

export class ClaudeAgentSdkProvider implements LLMProvider {
  readonly providerType: SecondLLMProviderType = "claude-agent-sdk";

  async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
    // 1. lllmAgent の ToolHandler 群を SDK MCP tool に変換
    const sdkTools = buildSdkToolsFromRegistry(params.tools);
    const mcpServer = createSdkMcpServer({
      name: "lllmagents",
      version: "1.0.0",
      tools: sdkTools,
    });

    // 2. SDK へクエリ
    const q = query({
      prompt: flattenMessagesToPrompt(params.messages),
      options: {
        model: resolveClaudeModelArg(params.model || this.config.model),
        tools: [],                                  // built-in 全消去
        mcpServers: { lllmagents: mcpServer.instance },
        allowedTools: ["mcp__lllmagents__*"],
        cwd: process.cwd(),
        // 認証は claude login 済みセッションを継承 (API key 不要)
      },
    });

    // 3. SDKMessage を ChatChunk に変換して yield
    for await (const msg of q) {
      yield* convertSdkMessageToChatChunks(msg);
    }
  }

  async *chat(params): AsyncGenerator<ChatChunk> {
    // ツール無しでも query() は使える
    yield* this.chatWithTools({ ...params, tools: [] });
  }
}
```

### 3.3 `sdk-mcp-bridge.ts` — ToolHandler → SDK tool 変換

```ts
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ToolHandler, ToolDefinition } from "../tools/tool-registry.js";
import type { ToolExecutionContext } from "../tools/tool-registry.js";

export function buildSdkToolsFromRegistry(
  toolDefs: ToolDefinition[],
  executor: ToolExecutor,
  context: ToolExecutionContext,
) {
  return toolDefs.map((def) => {
    const name = def.function.name;
    const description = def.function.description;
    const zodSchema = jsonSchemaToZod(def.function.parameters);

    return tool(name, description, zodSchema, async (args) => {
      const result = await executor.executeByName(name, args, context);
      return {
        content: [{ type: "text", text: result.output ?? result.error ?? "" }],
        isError: !result.success,
      };
    });
  });
}
```

**ポイント**:
- 既存の 39 個前後の ToolHandler を **無改造**で SDK に乗せられる
- `isError: true` を返すことで agent-loop の中で SDK が継続できる（exception を投げない）
- JSON Schema → Zod 変換は最小限のラッパーで足りる（`type/properties/required` のみ対応で十分）

### 3.4 認証フロー

- `claude login` 済みなら自動的に subscription を継承（API キー不要）
- 未ログインの場合は SDK が起動時にエラー → user に `claude login` を案内
- `pathToClaudeCodeExecutable` で claude バイナリの場所を override 可能（バンドル native binary が動かない環境向け）

### 3.5 REPL UX

```
/model setup claude-agent-sdk    # モデル選択のみ (認証は claude CLI 側)
/second setup claude-agent-sdk   # セカンドLLM として設定
```

`setupClaudeLLM(target, provider)` を `claude-agent-sdk` 対応に拡張する。

## 4. `claude-cli` の Fail loud 修正

新プロバイダ完成と独立に、**サイレント degrade を止める**修正は即時入れる。

### 4.1 修正方針

`src/providers/claude-cli.ts:99-102`

```ts
// 変更前 (悪)
async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
  yield* this.doChat(params);  // ← tools を黙って捨てる
}

// 変更後 (良)
async *chatWithTools(params: ChatWithToolsParams): AsyncGenerator<ChatChunk> {
  if (params.tools && params.tools.length > 0) {
    yield {
      type: "error",
      error:
        `[claude-cli] このプロバイダはツール呼び出しを橋渡ししません。\n` +
        `ツール付きエージェントループには 'anthropic' または 'claude-agent-sdk' プロバイダを使ってください。\n` +
        `→ /model setup claude-agent-sdk で切り替え可能。`,
    };
    return;
  }
  yield* this.doChat(params);
}
```

### 4.2 agent-loop 側の Capability チェック (任意)

provider.supportsFunctionCalling を見て、ツール委任前提の system-prompt（second_llm_agent 等の記述）を出さないように分岐するのが本筋。本書スコープでは provider 層の Fail loud までを必須とし、system-prompt の動的調整は別タスク。

## 5. ローカル LLM ブリッジ

新プロバイダの副次効果として、**claude (subscription) → lllmAgent → ローカル LLM** のブリッジが成立する:

```
User ─► lllmAgent ─► ClaudeAgentSdkProvider ─► Claude Opus 4.7
                                                     │
                                                     │ tool_use("second_llm_agent")
                                                     ▼
                                              SDK MCP handler
                                                     │
                                                     ▼
                                              SecondLLMManager.runAsAgent()
                                                     │
                                                     ▼
                                              llamacpp @ 192.168.1.201:9081
                                                     │
                                              (Qwen3.6 がコード生成等)
```

実装は **追加コストゼロ**。`second_llm_agent` ツールが SDK MCP に乗っていれば、Claude が判断して自然に呼ぶ。

逆方向（ローカル LLM が Claude を呼ぶ）は `second_llm` 経路で既に成立しているため、**双方向ブリッジ**になる。

## 6. 段階的実装計画

| Phase | 内容 | 行数目安 | 工数 |
|---|---|---|---|
| 0 | `claude-cli` Fail loud 修正 + テスト | ~30 | 30分 |
| 1 | SDK 依存追加 (`npm i @anthropic-ai/claude-agent-sdk`) + 型定義整備 | ~10 | 10分 |
| 2 | `sdk-mcp-bridge.ts` (ToolHandler → SDK tool 変換) | 100-150 | 半日 |
| 3 | `claude-agent-sdk.ts` プロバイダ本体 | 200-300 | 半日 |
| 4 | `provider-factory.ts` / `types.ts` への登録、REPL setup フロー | 50 | 1h |
| 5 | テスト (vitest, in-process MCP 呼び出し) | 200 | 半日 |
| 6 | 既存 `claude-providers.md` を更新（新プロバイダ追加、claude-cli 制約を明記） | – | 30分 |

**合計 ~700 行 / 1.5 セッション**。

Phase 0 だけ即時入れて、Phase 1-6 は user 合意後に進める。

## 7. リスクと未決事項

| # | 項目 | 評価 | 対応 |
|---|---|---|---|
| R1 | SDK の `claude login` 認証継承が macOS / Linux / Windows で挙動差あるか | 中 | macOS で動作確認、他 OS は配布時に検証 |
| R2 | SDK が内部で claude バイナリを spawn する場合、deploy/localllm.exe からの呼び出しで PATH 解決が壊れる可能性 | 中 | `pathToClaudeCodeExecutable` で明示できる |
| R3 | SDK のバージョンアップで API シグネチャが変わる | 中 | 依存バージョンを固定し、CHANGELOG を追跡 |
| R4 | `tools: []` で built-in 全消去すると Claude が file 操作したい時に lllmAgent ツールしか持たない → lllmAgent 側 ToolExecutor の網羅性が前提 | 高 | 既存 39 ツールでカバーできる範囲を事前確認 |
| R5 | SDK 経由の使用も Anthropic subscription の rate limit / クォータ消費対象。無制限ではない | 低 | エラー時の messaging（クォータ超過の旨）を SDK エラー文から判定して伝える |
| R6 | `pathToClaudeCodeExecutable` 未指定時に SDK が探す claude バイナリと、lllmAgent が `claude-cli` プロバイダで spawn しているバイナリが別物になる可能性 | 低 | factory で同じパス解決ロジックを使う |

## 8. 後方互換

- 既存 `anthropic` / `claude-cli` プロバイダは破壊変更なし
- `claude-cli` の Fail loud 修正は「以前は無音で動いていた」ケースを「明示エラーで止まる」 に変える ← **意図的な破壊変更**（負債解消のため）
- `mainLLM.providerType = "claude-cli"` でツール委任前提の作業を依頼していたユーザーは、新プロバイダ `claude-agent-sdk` への移行を促される

## 9. user 合意が必要なポイント

1. **Phase 0 (Fail loud) を即時マージしてよいか** — 既存挙動の破壊を含む
2. **Phase 1-6 を本セッションで続けるか、別セッションに分けるか**
3. **新プロバイダ名 `claude-agent-sdk` でよいか** — 代替案: `claude-sdk`, `claude-local`
4. **`tools: []` で built-in 全消去する方針でよいか** — 代替: claude の Read/Write 等も併用させる（重複・混乱リスク有）

## 10. 参考

- [Claude Agent SDK – Custom Tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Claude Agent SDK – TypeScript Reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [CLI Reference (--mcp-config / --print)](https://code.claude.com/docs/en/cli-reference)
- [Issue #26364 – MCP unavailable in --print mode](https://github.com/anthropics/claude-code/issues/26364)
- 既存設計書: `docs/claude-providers.md`
