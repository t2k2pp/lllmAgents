# LocalLLM Agent - 設計書

## 1. アーキテクチャ概要

```
┌────────────────────────────────────────────────┐
│                    CLI (REPL)                    │
│  - readline ベース                              │
│  - マルチライン入力 (``` で囲む)                │
│  - スラッシュコマンド (/help, /plan, /skill...)  │
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
│ 22 tools│ │- 80%   │ │  - plan          │
│(下記参照)│ │  圧縮  │ │  - general       │
│         │ │- LLM   │ │  - bash          │
│         │ │  要約  │ │  - 並列実行      │
└──────┬──┘ └────────┘ └──────────────────┘
       │
┌──────▼──────────────────────────────────────────┐
│               ToolRegistry (22 tools)            │
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
│   enter_plan_mode - プランモード開始             │  ← NEW
│   exit_plan_mode  - プランモード終了(承認依頼)    │  ← NEW
│                                                  │
│ サブエージェント:                                 │
│   task         - サブエージェント起動             │  ← NEW
│                                                  │
│ スキル:                                          │
│   skill        - スキル実行                      │  ← NEW
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
- `/skill` - 利用可能なスキル一覧
- `/agents` - 実行中のサブエージェント一覧
- `/status` - 全体ステータス (コンテキスト + タスク + エージェント)

**UX改善**:
- マルチライン入力時に行番号表示
- ツール実行のサマリー表示強化
- マークダウンレンダリング (marked ライブラリ)

## 3. ファイル構成 (変更後)

```
src/
├── agent/
│   ├── agent-loop.ts        # メインエージェントループ (並列ツール追加)
│   ├── sub-agent.ts         # サブエージェント (実装済)
│   ├── plan-mode.ts         # プランモード管理 (NEW)
│   ├── message-history.ts   # メッセージ履歴
│   ├── token-counter.ts     # トークン推定
│   ├── context-manager.ts   # コンテキスト圧縮
│   ├── session-manager.ts   # セッション永続化
│   ├── memory.ts            # 自動メモリ
│   ├── project-context.ts   # CLAUDE.md等読み込み
│   ├── system-prompt.ts     # システムプロンプト構築 (更新)
│   └── hooks.ts             # フックシステム
├── skills/                   # NEW ディレクトリ
│   ├── skill-registry.ts    # スキル登録・検索
│   ├── skill-loader.ts      # スキルファイル読み込み
│   └── builtin/             # 組み込みスキル
│       ├── commit.md
│       ├── pr-review.md
│       ├── tdd.md
│       └── build-fix.md
├── tools/
│   ├── tool-registry.ts
│   ├── tool-executor.ts
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
│       ├── task.ts           # NEW - サブエージェント起動ツール
│       ├── plan-mode.ts      # NEW - プランモードツール
│       └── skill.ts          # NEW - スキル実行ツール
├── cli/
│   ├── repl.ts              # 強化 (追加コマンド)
│   └── renderer.ts          # 強化 (マークダウンレンダリング)
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
                            └─ ToolHandler.execute()
                                  │
                                  └─ 結果 → history → LLMループ継続
```
