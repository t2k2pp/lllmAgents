# LocalLLM Agent - 設計書

## 1. アーキテクチャ概要

```
┌────────────────────────────────────────────────┐
│                    CLI (REPL)                    │
│  - readline ベース                              │
│  - マルチライン入力 (``` で囲む)                │
│  - スラッシュコマンド (/help, /plan, /skill,     │
│    /mode, ...)                                    │
│  - Ctrl+C でキャンセル                          │
└──────────────────┬─────────────────────────────┘
                   │
┌──────────────────▼─────────────────────────────┐
│                AgentLoop                        │
│  - ユーザーメッセージ → LLM → ツール → LLM...  │
│  - MAX_TOOL_ITERATIONS = 50                     │
│  - リトライ (MAX_RETRIES = 2, exp backoff)      │
│  - ストリーミング出力 (SSE → stdout)            │
│  - プランモード (設計→承認→実行)                │
│  - 並列ツール実行 (Promise.allSettled)           │
│  - セッション保存/復元                          │
└──────┬─────────┬──────────┬─────────────────────┘
       │         │          │
┌──────▼──┐ ┌───▼────┐ ┌──▼──────────────┐
│ToolExec │ │Context │ │  SubAgentManager │
│         │ │Manager │ │  - explore       │
│ 21 tools│ │- 80%   │ │  - plan          │
│(下記参照)│ │  圧縮  │ │  - general       │
│         │ │- LLM   │ │  - bash          │
│+ Hooks  │ │  要約  │ │  - 並列実行      │
└──────┬──┘ └────────┘ └──────────────────┘
       │
       ├──┬──────────────────────────────────────┐
       │  │  HookManager                          │
       │  │  - PreToolUse / PostToolUse            │
       │  │  - SessionStart / SessionStop          │
       │  │  - hooks.json (project / global)       │
       │  └──────────────────────────────────────┘
       │
       ├──┬──────────────────────────────────────┐
       │  │  RuleLoader                            │
       │  │  - builtin: security, coding-style,    │
       │  │    git-workflow                         │
       │  │  - ~/.localllm/rules/, .claude/rules/  │
       │  │  - システムプロンプトに注入             │
       │  └──────────────────────────────────────┘
       │
       ├──┬──────────────────────────────────────┐
       │  │  ContextModeManager                    │
       │  │  - dev / review / research             │
       │  │  - /mode コマンドで切替                 │
       │  │  - システムプロンプトに注入             │
       │  └──────────────────────────────────────┘
       │
       ├──┬──────────────────────────────────────┐
       │  │  AgentDefinitionLoader                 │
       │  │  - .md + YAML frontmatter              │
       │  │  - builtin: explore, plan,             │
       │  │    general-purpose, code-reviewer       │
       │  │  - ~/.localllm/agents/ (override)       │
       │  │  - .localllm/agents/ (override)         │
       │  └──────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────┐
│               ToolRegistry (21 tools)            │
├─────────────────────────────────────────────────┤
│ ファイル系:                                      │
│   file_read    - ファイル読取(行番号付き)         │
│   file_write   - ファイル書込(自動mkdir)          │
│   file_edit    - 文字列置換(一意性チェック)       │
│   glob         - パターン検索                    │
│   grep         - 内容検索(rg fallback付)         │
│                                                  │
│ システム系:                                      │
│   bash         - シェル実行(タイムアウト120s)     │
│                                                  │
│ Web系:                                           │
│   web_fetch    - URL取得→テキスト変換            │
│   web_search   - DuckDuckGo検索                  │
│                                                  │
│ 対話系:                                          │
│   todo_write   - タスクリスト管理                 │
│   ask_user     - ユーザーへの質問                 │
│                                                  │
│ プランモード:                                    │
│   enter_plan_mode - プランモード開始             │
│   exit_plan_mode  - プランモード終了(承認依頼)    │
│                                                  │
│ サブエージェント:                                 │
│   task         - サブエージェント起動             │
│   task_output  - サブエージェント結果取得         │
│                                                  │
│ スキル:                                          │
│   skill        - スキル実行                      │
│                                                  │
│ ブラウザ系:                                      │
│   browser_navigate  - ページ遷移                 │
│   browser_snapshot  - アクセシビリティツリー       │
│   browser_click     - 要素クリック               │
│   browser_type      - テキスト入力               │
│   browser_screenshot - スクリーンショット         │
│                                                  │
│ ビジョン:                                        │
│   vision_analyze - 画像分析(サブLLM委任)         │
└─────────────────────────────────────────────────┘
```

## 2. 今回追加する機能

### 2.1 サブエージェント(Task)システム

**ファイル**: `src/agent/sub-agent.ts` (実装済)、`src/tools/definitions/task.ts` (NEW)

**設計**:
- `SubAgent` クラス: 独立した AgentLoop を持つ子エージェント
- `SubAgentManager`: 複数サブエージェントの管理・並列実行
- タイプ: `explore`(読取専用), `plan`(調査+計画), `general-purpose`(全ツール), `bash`(コマンド特化)
- 各タイプごとにツールを制限（exploreはfile_read/glob/grepのみ等）
- 再帰防止: general-purposeサブエージェントからはtaskツール除外

**ツール定義** (`task` tool):
```typescript
params: {
  subagent_type: "explore" | "plan" | "general-purpose" | "bash",
  description: string,   // 3-5語の短い説明
  prompt: string,         // タスクの詳細
  run_in_background?: boolean  // バックグラウンド実行
}
returns: SubAgentResult { agentId, type, description, result, success }
```

### 2.2 プランモード

**ファイル**: `src/agent/plan-mode.ts` (NEW)、`src/tools/definitions/plan-mode.ts` (NEW)

**設計**:
- `PlanManager` クラス: プランの状態管理
- 状態: `idle` → `planning` → `awaiting_approval` → `approved` / `rejected`
- プランファイル: `.localllm/plans/{timestamp}.md` に保存
- `enter_plan_mode` ツール: プランモードに入る
- `exit_plan_mode` ツール: プランを提示してユーザー承認を待つ
- AgentLoop統合: プランモード中はread-onlyツールのみ使用可能

**ツール定義**:
```typescript
// enter_plan_mode
params: {} // パラメータなし
returns: { mode: "planning", message: "プランモードに入りました" }

// exit_plan_mode
params: {
  plan_file: string  // プランファイルのパス
}
returns: { approved: boolean, feedback?: string }
```

### 2.3 Agent Skills システム

**ファイル**: `src/skills/skill-registry.ts` (NEW)、`src/skills/skill-loader.ts` (NEW)、`src/tools/definitions/skill.ts` (NEW)

**設計**:
- スキル定義: Markdownファイル (.localllm/skills/ 配下)
- フォーマット:
  ```markdown
  ---
  name: commit
  description: Git commit workflow
  trigger: /commit
  ---
  # Commit Skill
  ## When to Use
  ユーザーがコミットを要求したとき
  ## How It Works
  1. git status で変更確認
  2. git diff で差分確認
  3. コミットメッセージ生成
  4. git add + git commit
  ```
- `SkillRegistry`: スキルの登録・検索・一覧
- `SkillLoader`: .localllm/skills/ とプロジェクトの .claude/skills/ からロード
- `skill` ツール: LLMがスキルを実行要求する
- REPLでの `/skill-name` コマンド: ユーザーが直接スキルを呼び出す

**組み込みスキル**: commit, pr-review, tdd, build-fix

### 2.4 並列ツール実行

**ファイル**: `src/agent/agent-loop.ts` (修正)

**設計**:
- LLMが1回のレスポンスで複数tool_callを返した場合、依存関係がなければ並列実行
- `Promise.allSettled()` で全結果を待つ
- 各ツールの spinner を同時表示
- 失敗しても他のツールは継続

**変更箇所** (agent-loop.ts line 130付近):
```typescript
// Before: sequential
for (const toolCall of toolCalls) { await execute(toolCall); }

// After: parallel
const results = await Promise.allSettled(
  toolCalls.map(tc => this.toolExecutor.execute(tc))
);
```

### 2.5 REPL強化

**ファイル**: `src/cli/repl.ts` (修正)、`src/cli/renderer.ts` (修正)

**追加コマンド**:
- `/plan` - プランモードに手動で入る
- `/skills` - 利用可能なスキル一覧
- `/status` - 全体ステータス (コンテキスト + タスク + エージェント)
- `/mode` - コンテキストモード切替 (dev / review / research)

**UX改善**:
- マルチライン入力時に行番号表示
- ツール実行のサマリー表示強化
- マークダウンレンダリング (marked ライブラリ)

## 3. ファイル構成 (変更後)

```
src/
├── agent/
│   ├── agent-loop.ts        # メインエージェントループ (並列ツール実行)
│   ├── sub-agent.ts         # サブエージェント
│   ├── plan-mode.ts         # プランモード管理
│   ├── message-history.ts   # メッセージ履歴
│   ├── token-counter.ts     # トークン推定
│   ├── context-manager.ts   # コンテキスト圧縮
│   ├── session-manager.ts   # セッション永続化
│   ├── memory.ts            # 自動メモリ
│   ├── project-context.ts   # CLAUDE.md等読み込み
│   └── system-prompt.ts     # システムプロンプト構築 (Rules/ContextMode注入)
├── agents/                   # エージェント定義ファイル
│   ├── agent-loader.ts      # AgentDefinitionLoader
│   └── builtin/             # 組み込みエージェント定義
│       ├── explore.md
│       ├── plan.md
│       ├── general-purpose.md
│       └── code-reviewer.md
├── hooks/                    # フックシステム
│   └── hook-manager.ts      # HookManager (PreToolUse/PostToolUse/Session)
├── rules/                    # 常時適用ルール
│   ├── rule-loader.ts       # RuleLoader
│   └── builtin/             # 組み込みルール
│       ├── security.md
│       ├── coding-style.md
│       └── git-workflow.md
├── context/                  # コンテキストモード
│   └── context-mode.ts      # ContextModeManager (dev/review/research)
├── mcp/                      # MCP (Model Context Protocol)
│   ├── types.ts             # JSON-RPC 2.0 / MCPプロトコル型定義
│   ├── mcp-client.ts        # MCPClient (stdio/SSEトランスポート)
│   └── mcp-manager.ts       # MCPManager (ライフサイクル管理・ツール登録)
├── skills/                   # スキルシステム
│   ├── skill-registry.ts    # スキル登録・検索
│   ├── skill-loader.ts      # スキルファイル読み込み
│   └── builtin/             # 組み込みスキル
│       ├── commit.md
│       ├── pr-review.md
│       ├── tdd.md
│       └── build-fix.md
├── tools/
│   ├── tool-registry.ts
│   ├── tool-executor.ts     # ToolExecutor (HookManager統合)
│   └── definitions/
│       ├── file-read.ts
│       ├── file-write.ts
│       ├── file-edit.ts
│       ├── glob.ts
│       ├── grep.ts
│       ├── bash.ts
│       ├── web-fetch.ts
│       ├── web-search.ts
│       ├── todo-write.ts
│       ├── ask-user.ts
│       ├── browser.ts
│       ├── vision.ts
│       ├── task.ts           # サブエージェント起動/結果取得ツール
│       ├── plan-mode.ts      # プランモードツール
│       └── skill.ts          # スキル実行ツール
├── cli/
│   ├── repl.ts              # REPL (/mode, /plan, /skills 等)
│   └── renderer.ts          # 出力レンダリング
├── security/
│   ├── rules.ts
│   ├── sandbox.ts
│   └── permission-manager.ts
├── providers/
│   ├── base-provider.ts
│   ├── openai-compat.ts
│   ├── ollama.ts
│   ├── lmstudio.ts
│   ├── llamacpp.ts
│   ├── vllm.ts
│   └── provider-factory.ts
├── browser/
│   └── playwright-manager.ts
├── config/
│   ├── types.ts
│   ├── config-manager.ts
│   └── setup-wizard.ts
├── utils/
│   ├── http-client.ts
│   ├── logger.ts
│   └── platform.ts
└── index.ts                  # エントリーポイント (更新)
```

## 4. セキュリティモデル

### 3層権限
| レベル | ツール | 動作 |
|--------|--------|------|
| auto | file_read, glob, grep, todo_write | 自動許可 |
| ask | bash, file_write, file_edit, browser_*, web_* | ユーザー確認 (once/always/deny) |
| deny | 危険コマンド (rm -rf /, format C:等) | 自動ブロック |

### サンドボックス
- 許可ディレクトリ: CWD + HOME + /tmp
- パス正規化後にチェック

### 危険コマンド検出
- 20+ regex パターン (rules.ts)
- block / warn の2段階

## 5. データフロー

```
ユーザー入力
    │
    ▼
REPL.processInput()
    │
    ├─ /command → handleCommand()
    │
    └─ テキスト → AgentLoop.run()
                      │
                      ├─ Context圧縮チェック
                      │
                      ▼
                  LLM.chatWithTools() ← ストリーミング
                      │
                      ├─ テキスト → stdout (リアルタイム)
                      │
                      └─ ToolCalls → 並列実行
                            │
                            ├─ PermissionManager.check()
                            │     ├─ auto → 実行
                            │     ├─ ask → inquirerで確認
                            │     └─ deny → ブロック
                            │
                            ├─ HookManager.runPreToolHooks()
                            │     ├─ proceed → 続行
                            │     └─ blocked (code≠0) → 中止
                            │
                            ├─ ToolHandler.execute()
                            │
                            ├─ HookManager.runPostToolHooks()
                            │
                            └─ 結果 → history → LLMループ継続
```

## 6. 拡張システム

### 6.1 Hooksシステム (`src/hooks/hook-manager.ts`)
- フックタイプ: `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionStop`
- 定義ファイル: `hooks.json`（プロジェクト `.claude/`, `.localllm/` およびグローバル `~/.localllm/`）
- `PreToolUse` は非ゼロ終了コードでツール実行をブロック可能
- 環境変数: `TOOL_NAME`, `FILE_PATH`, `TOOL_OUTPUT`, `TOOL_SUCCESS`, `TOOL_ERROR`
- `ToolExecutor` のコンストラクタに `HookManager` を注入して統合

### 6.2 Rulesシステム (`src/rules/rule-loader.ts`)
- 常時適用ルールを `.md` ファイルで定義
- 組み込み3種: `security.md`, `coding-style.md`, `git-workflow.md`
- ロード順: builtin → `~/.localllm/rules/` → `.claude/rules/` → `.localllm/rules/`
- `buildSystemPrompt()` 内で `RuleLoader.formatForSystemPrompt()` を呼び出してシステムプロンプトに注入

### 6.3 コンテキストモード (`src/context/context-mode.ts`)
- 3モード: `dev`（開発）, `review`（コードレビュー）, `research`（リサーチ）
- 各モードに `priority`, `behavior`, `preferredTools` を定義
- `/mode` コマンドで REPL から切替
- `buildSystemPrompt()` 内でシステムプロンプトに注入

### 6.4 エージェント定義ファイル (`src/agents/agent-loader.ts`)
- `.md` + YAML フロントマター形式（`name`, `description`, `tools`, `allowedTools`）
- 組み込み4種: `explore`, `plan`, `general-purpose`, `code-reviewer`
- ロード順: `src/agents/builtin/` → `~/.localllm/agents/` → `.localllm/agents/`（同名は後から上書き）
- 遅延ロード: `get(name)` 初回呼び出し時に全定義を読み込み

### 6.5 MCP (Model Context Protocol) (`src/mcp/`)
- JSON-RPC 2.0ベースのプロトコルで外部ツールサーバーと通信
- トランスポート: `stdio`（子プロセス stdin/stdout）, `sse`（HTTP SSE + POST）
- **MCPClient** (`mcp-client.ts`): 接続管理、`initialize` → `tools/list` → `tools/call` のプロトコルフロー
- **MCPManager** (`mcp-manager.ts`): 設定ロード、全サーバー接続、MCPツール→ToolHandler変換・ToolRegistry登録
- 設定ファイル: `~/.localllm/mcp-servers.json` → `.localllm/mcp-servers.json` → `.claude/mcp-servers.json`
- ツール命名規則: `mcp__<サーバー名>__<ツール名>`
- ライフサイクル: アプリ起動時 `connectAll()` → ToolRegistry登録 → 利用 → 終了時 `disconnectAll()`
- 既存のPermissionManager・HookManagerと統合済み（MCPツールにも同じセキュリティポリシー適用）
