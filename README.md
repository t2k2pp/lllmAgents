# LocalLLM Agent

ローカルLLMを使ったCLI型AIエージェント。Claude Codeにインスパイアされた、PC操作が可能な対話型アシスタント。

## 特徴

- **ローカルLLM対応**: Ollama, LM Studio, llama.cpp, vLLM をサポート
- **15種のツール**: ファイル操作、コマンド実行、ブラウザ操作、Web検索をLLMが自律的に実行
- **セキュリティ**: Claude Code準拠の3段階権限モデル（自動許可/要確認/禁止）+ 50以上の危険コマンド検出パターン
- **サブエージェント**: タスク委譲による並列・バックグラウンド処理（explore / plan / general-purpose / bash）
- **プランモード**: 読み取り専用の計画フェーズで設計を固めてから実装
- **スキルシステム**: TDD、コミット、PRレビュー等のワークフローを `/commit` のように直接呼び出し
- **コンテキスト管理**: 80%消費時に自動圧縮（LLM自身による要約）
- **セッション管理**: 会話の保存・復元・継続
- **永続メモリ**: セッションを跨いで知識を蓄積
- **画像認識**: Vision非対応LLM向けにサブLLM委譲をサポート
- **ブラウザ操作**: Playwright統合によるWeb自動化
- **マルチライン入力**: Shift+Enter / Ctrl+J で改行、@path でファイル参照
- **インタラクティブUI**: `/`コマンドと`@`ファイルパスの補完ドロップダウン
- **コンテキストモード**: dev / review / research の3モードで動作を最適化
- **フック・ルール**: ツール実行前後のフック、コーディングスタイル等のルール自動適用
- **クロスプラットフォーム**: Windows, macOS, Linux対応

## セットアップ

```bash
# インストール
npm install

# 初回設定（セットアップウィザード）
npm run setup

# 起動
npm start
```

### セットアップウィザードの流れ

1. LLMサーバーの種類を選択（Ollama / LM Studio / llama.cpp / vLLM）
2. サーバーのIPアドレスとポートを入力
3. 接続テスト → 利用可能モデル一覧を自動取得
4. モデルをリストから選択（手入力不要）
5. コンテキストウインドウサイズを設定（デフォルト: モデル上限）
6. 画像認識用サブLLMの設定（任意）

## 使い方

```
$ npm start

  LocalLLM Agent v0.3.0
  Model: qwen3.5:27b @ http://192.168.1.33:11434 (Ollama)
  Context: 130K tokens | Skills: 4
  CWD: /home/user/my-project
  Type /help for commands, /quit to exit.
  マルチライン: Shift+Enter / Ctrl+J (フォールバック: ```)

> このディレクトリのファイルを見せて
  ✔ glob
  カレントディレクトリの内容: ...

> README.md を編集して、タイトルを変更して
  [file_edit] README.md を編集します。よろしいですか？ [y/N]
```

### 入力方法

| 操作 | 説明 |
|------|------|
| `Shift+Enter` | 改行を挿入（マルチライン入力） |
| `Ctrl+J` | 改行を挿入（Shift+Enter非対応ターミナル用） |
| ` ``` ` | マルチライン入力モード開始/終了（フォールバック） |
| `@path` | ファイル/フォルダの内容をプロンプトに添付 |
| `/command` | スラッシュコマンド（補完ドロップダウン付き） |
| `Ctrl+C` | 現在の操作をキャンセル |

### コマンド一覧

| コマンド | 説明 |
|----------|------|
| `/help` | ヘルプ表示 |
| `/quit` `/exit` | 終了 |
| `/clear` | 会話履歴クリア |
| `/context` | コンテキスト使用状況（トークン数・進捗バー） |
| `/compact` | コンテキストを手動圧縮 |
| `/model` | 現在のモデル情報 |
| `/model list` | 利用可能なモデル一覧 |
| `/model <name>` | モデルを切り替え |
| `/todo` | タスクリスト表示 |
| `/sessions` | 保存済みセッション一覧（直近10件） |
| `/resume <id>` | セッション復元 |
| `/continue` | 最新セッションを復元 |
| `/memory` | 永続メモリ表示 |
| `/remember <text>` | メモリに追記 |
| `/diff` | git diff 表示 |
| `/plan` | プランモードに入る |
| `/skills` | 利用可能なスキル一覧 |
| `/status` | 全体ステータス（モデル・コンテキスト・タスク等） |
| `/mode <dev\|review\|research>` | コンテキストモード切り替え |

### スキル（直接呼び出し）

| コマンド | 説明 |
|----------|------|
| `/commit` | コミットワークフロー |
| `/pr-review` | PRコードレビュー |
| `/tdd` | テスト駆動開発（Red-Green-Refactor） |
| `/build-fix` | ビルドエラー修正 |

## ツール一覧

LLMが自律的に呼び出す15種のツール:

| ツール | 権限 | 説明 |
|--------|------|------|
| `file_read` | 自動 | ファイル読み取り（行番号付き、offset/limit対応） |
| `file_write` | 要確認 | ファイル作成・上書き |
| `file_edit` | 要確認 | 文字列置換による部分編集 |
| `glob` | 自動 | パターンによるファイル検索 |
| `grep` | 自動 | 正規表現によるコンテンツ検索 |
| `bash` | 要確認 | シェルコマンド実行（120秒タイムアウト） |
| `web_search` | 自動 | Web検索（DuckDuckGo、APIキー不要） |
| `web_fetch` | 自動 | URL取得（HTML→テキスト変換） |
| `ask_user` | 自動 | ユーザーへの質問・選択肢提示 |
| `todo_write` | 自動 | タスクリスト管理 |
| `enter_plan_mode` | 自動 | プランモード開始 |
| `exit_plan_mode` | 自動 | プラン承認リクエスト |
| `task` | 自動 | サブエージェントへのタスク委譲 |
| `task_output` | 自動 | バックグラウンドタスクの結果取得 |
| `skill` | 自動 | スキルテンプレートの実行 |

### ブラウザツール（Playwright）

| ツール | 権限 | 説明 |
|--------|------|------|
| `browser_navigate` | 要確認 | URLを開く |
| `browser_snapshot` | 自動 | アクセシビリティツリー取得 |
| `browser_click` | 要確認 | 要素クリック |
| `browser_type` | 要確認 | テキスト入力 |
| `browser_screenshot` | 自動 | スクリーンショット取得 |
| `vision_analyze` | 自動 | 画像をVision LLMで分析 |

## サブエージェント

`task` ツールで専門的なサブエージェントにタスクを委譲:

| タイプ | 用途 | 使用可能ツール | 最大ターン |
|--------|------|----------------|-----------|
| `explore` | コードベース探索 | file_read, glob, grep | 20 |
| `plan` | 設計・計画 | file_read, glob, grep | 15 |
| `general-purpose` | 汎用タスク | 全ツール | 30 |
| `bash` | コマンド実行 | bash, file_read, glob, grep | 15 |

フォアグラウンド（完了まで待機）またはバックグラウンド（`task_output`で結果取得）で実行可能。

## コンテキストモード

`/mode` コマンドでLLMの動作を最適化:

| モード | 優先順位 | 適したシーン |
|--------|----------|-------------|
| `dev` | 動く → 正しい → 綺麗 | コード実装・機能追加 |
| `review` | 重大 > 高 > 中 > 低 | コードレビュー・品質検査 |
| `research` | 理解 → 検証 → 文書化 | 調査・学習・ドキュメント作成 |

## プランモード

実装前に設計を固めるための読み取り専用フェーズ:

1. `/plan` またはLLMが `enter_plan_mode` を呼び出して開始
2. ファイル読み取り・検索のみ可能（書き込み不可）
3. 計画を `~/.localllm/plans/` に保存
4. `exit_plan_mode` でユーザーに承認を要求
5. 承認後、実装フェーズに移行

## アーキテクチャ

```
src/
├── index.ts                # エントリーポイント
├── cli/                    # REPL・インタラクティブUI
│   ├── repl.ts             # コマンドハンドラ・メインループ
│   ├── interactive-input.ts # マルチライン入力・補完ドロップダウン
│   ├── input-resolver.ts   # @ファイル参照の解決
│   ├── completer.ts        # コマンド・パス補完
│   └── renderer.ts         # ヘルプ・ウェルカム表示
├── config/                 # 設定管理
│   ├── config-manager.ts   # ~/.localllm/config.json 読み書き
│   ├── setup-wizard.ts     # 初回セットアップウィザード
│   └── types.ts            # 設定の型定義
├── providers/              # LLMプロバイダー（5種）
│   ├── base-provider.ts    # 共通インターフェース
│   ├── openai-compat.ts    # OpenAI互換API共通実装（SSE対応）
│   ├── ollama.ts           # Ollama（/api/tags, /api/show）
│   ├── lmstudio.ts         # LM Studio
│   ├── llamacpp.ts         # llama.cpp
│   ├── vllm.ts             # vLLM
│   └── provider-factory.ts # プロバイダー自動検出・生成
├── agent/                  # エージェントコア
│   ├── agent-loop.ts       # メインループ（最大50イテレーション）
│   ├── sub-agent.ts        # サブエージェント委譲
│   ├── message-history.ts  # 会話履歴管理
│   ├── context-manager.ts  # コンテキスト圧縮
│   ├── token-counter.ts    # トークン数推定
│   ├── session-manager.ts  # セッション保存・復元
│   ├── memory.ts           # 永続メモリ
│   ├── plan-mode.ts        # プランモード状態管理
│   └── system-prompt.ts    # システムプロンプト動的構築
├── tools/                  # ツールフレームワーク
│   ├── tool-registry.ts    # ツール登録
│   ├── tool-executor.ts    # 権限チェック・フック付き実行
│   └── definitions/        # 15種のツール実装
├── agents/                 # サブエージェント定義
│   ├── agent-loader.ts     # Markdown定義の読み込み
│   └── builtin/            # 組み込みエージェント
├── skills/                 # スキル（ワークフローテンプレート）
│   ├── skill-registry.ts   # スキル登録・トリガー管理
│   ├── skill-loader.ts     # Markdown定義の読み込み
│   └── builtin/            # 4つの組み込みスキル
├── rules/                  # ルールシステム
│   ├── rule-loader.ts      # 3ソースからの読み込み
│   └── builtin/            # coding-style, git-workflow, security
├── hooks/                  # フックシステム
│   └── hook-manager.ts     # PreToolUse / PostToolUse / Session
├── security/               # セキュリティ
│   ├── permission-manager.ts # 権限レベル管理
│   ├── sandbox.ts          # ファイルシステムサンドボックス
│   └── rules.ts            # 危険コマンド検出（50+パターン）
├── context/                # コンテキストモード
│   └── context-mode.ts     # dev / review / research
├── browser/                # Playwright統合
│   └── playwright-manager.ts
├── mcp/                    # MCP (Model Context Protocol)
│   ├── mcp-client.ts       # MCPプロトコルクライアント
│   └── mcp-manager.ts      # MCPサーバーライフサイクル
└── utils/                  # ユーティリティ
    ├── logger.ts           # ロギング
    ├── platform.ts         # OS検出・パス正規化
    └── http-client.ts      # HTTP通信
```

## セキュリティモデル

### 権限レベル

| レベル | ツール | 説明 |
|--------|--------|------|
| 自動許可 | file_read, glob, grep, web_search, web_fetch, ask_user, todo_write 等 | 読み取り・内部操作 |
| 要確認 | file_write, file_edit, bash, browser操作 | 変更を伴う操作 |
| 禁止 | サンドボックス外のファイル操作 | 安全性のため |

### サンドボックス

- カレントディレクトリ + `~/.localllm/` + 設定で指定したディレクトリのみアクセス可能
- シンボリックリンク解決による保護
- Windows パス正規化（8.3形式・UNCパス対応）

### 危険コマンド検出

50以上のパターンで破壊的コマンドを自動検出:
- 破壊的操作: `rm -rf /`, `mkfs`, `dd`, `format`
- システム: `shutdown`, `reboot`, フォーク爆弾
- 実行チェーン: `curl | bash`, `wget | sh`
- Git: `push --force` (main/master), `reset --hard`
- 認証情報漏洩: `echo $PASSWORD`, `export API_KEY`

## フック・ルール

### フック

ツール実行前後に自動処理を挿入:

| タイプ | タイミング |
|--------|-----------|
| `PreToolUse` | ツール実行前 |
| `PostToolUse` | ツール実行後 |
| `SessionStart` | セッション開始時 |
| `SessionStop` | セッション終了時 |

読み込み優先順: 組み込み → ユーザーグローバル (`~/.localllm/hooks/`) → プロジェクト (`.localllm/hooks/`)

### ルール

Markdownファイルで定義するコーディング規約・ガイドライン:

- **coding-style** - コードフォーマット基準
- **git-workflow** - Git操作ガイドライン
- **security** - セキュリティプラクティス

読み込み優先順: 組み込み → ユーザーグローバル (`~/.localllm/rules/`) → プロジェクト (`.localllm/rules/`)

## 設定

設定ファイル: `~/.localllm/config.json`

```json
{
  "mainLLM": {
    "providerType": "ollama",
    "baseUrl": "http://192.168.1.100:11434",
    "model": "qwen3.5:27b",
    "contextWindow": 130000,
    "temperature": 0.7
  },
  "visionLLM": null,
  "security": {
    "allowedDirectories": [],
    "autoApproveTools": ["file_read", "glob", "grep", "browser_snapshot", "vision_analyze"]
  },
  "context": {
    "compressionThreshold": 0.8
  }
}
```

### データディレクトリ

| パス | 内容 |
|------|------|
| `~/.localllm/config.json` | 設定ファイル |
| `~/.localllm/sessions/` | セッション履歴 |
| `~/.localllm/memory/MEMORY.md` | 永続メモリ |
| `~/.localllm/plans/` | プランモードの計画書 |
| `~/.localllm/hooks/` | ユーザーグローバルフック |
| `~/.localllm/rules/` | ユーザーグローバルルール |

## テスト

```bash
# 全テスト実行
npm test

# ウォッチモード
npm run test:watch

# 型チェック
npm run lint
```

## 必要環境

- Node.js 18+
- ローカルLLMサーバー（Ollama / LM Studio / llama.cpp / vLLM）
- Playwright（ブラウザ操作を使う場合）

## ライセンス

MIT
