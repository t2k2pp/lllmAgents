# 内部設計書 (Internal Design)

本ドキュメントでは、LocalLLM Agent の内部アーキテクチャ、コンポーネント間の連携構造、モジュール設計、データの流れについて定義します。

## 1. ソフトウェア・アーキテクチャ

システムは、CLIフロントエンドからLLMプロバイダまで、責務ごとにモジュール化されたレイヤードアーキテクチャを採用しています。

```mermaid
graph TD
    classDef ui fill:#e1f5fe,stroke:#0288d1;
    classDef core fill:#fff3e0,stroke:#f57c00;
    classDef infra fill:#f1f8e9,stroke:#689f38;
    classDef sec fill:#ffebee,stroke:#d32f2f;

    subgraph "Presentation Layer (CLI)"
        REPL[cli/repl.ts]:::ui
        Renderer[cli/renderer.ts]:::ui
    end

    subgraph "Application Core Layer"
        AL[AgentLoop]:::core
        PM[PlanManager]:::core
        SM[SubAgentManager]:::core
        CM[ContextManager]:::core
        Mem[MessageHistory]:::core
    end

    subgraph "Domain / Services Layer"
        TR[ToolRegistry]:::core
        TE[ToolExecutor]:::core
        SR[SkillRegistry]:::core
    end

    subgraph "Security Layer"
        Perm[PermissionManager]:::sec
        Sand[Sandbox]:::sec
        Rules[SecurityRules]:::sec
    end

    subgraph "Infrastructure Layer"
        Prov[Provider Interfaces]:::infra
        Clients[Ollama / LMStudio / vLLM 등]:::infra
        Play[PlaywrightManager]:::infra
    end

    REPL --> |User Input| AL
    AL --> Mem
    AL --> CM
    AL <--> |Status / Events| PM
    AL --> |Delegation| SM
    AL --> |Inference Request| Prov
    Prov --> Clients
    
    AL --> |Parse Tool Calls| TE
    TE --> |Check Tools| TR
    TE --> |Check Skills| SR
    TE --> |Authorize| Perm

    Perm --> Sand
    Perm --> Rules
    
    TE --> |Execute Web| Play

```

## 2. コンポーネント詳細・内部ロジック

### 2.1 AgentLoop の実行フロー
メインとなる思考ループ（推論とツール実行のサイクル）のフローを以下に示します。
特筆すべきは、LLMからの複数のTool Callsを `Promise.allSettled` で**並列処理**している点です。

```mermaid
sequenceDiagram
    participant User
    participant Loop as AgentLoop
    participant Context as ContextManager
    participant LLM as Provider (LLM)
    participant Exec as ToolExecutor

    User->>Loop: メッセージ入力
    Loop->>Loop: Historyに追加
    
    Loop->>Context: shouldCompress() ?
    alt 要圧縮
        Context->>LLM: 圧縮用プロンプト実行
        LLM-->>Context: 要約結果
        Context->>Loop: Historyの圧縮置換
    end

    loop Max Iterations (50)
        Loop->>LLM: chatWithTools(History)
        LLM-->>Loop: Stream Response (Text + ToolCalls)
        
        alt ToolCallsあり
            Loop->>Exec: execute(ToolCall 1) (Parallel)
            Loop->>Exec: execute(ToolCall 2) (Parallel)
            Exec-->>Loop: 実行結果 1 & 2
            Loop->>Loop: Historyに結果を追加 -> (次ループへ)
        else ToolCallsなし (完了)
            Loop-->>User: 最終回答の出力
            break Loop終了
        end
    end
```

### 2.2 サブエージェントのライフサイクル (`SubAgentManager`)
複雑なタスクを分割処理するために、独立した内部エージェントを生成します。

```mermaid
stateDiagram-v2
    state "AgentLoop (Main)" as Main
    state "SubAgentManager" as SAM
    
    Main --> SAM : taskツール実行
    
    state SAM {
        [*] --> Initialize: タイプ決定(plan, explore, bash等)
        Initialize --> IsolateContext: 独自のHistory空間生成
        IsolateContext --> SubLoop: 子AgentLoop実行
        SubLoop --> ToolExec: 限定されたツール群の使用
        ToolExec --> SubLoop
        SubLoop --> Finalize: タスク完了報告生成
    }
    
    SAM --> Main : 報告/結果をMainのHistoryへ追加
```

### 2.3 プランモード (`PlanManager`) による状態制御
「計画なしに破壊的変更を行うこと」を防ぐため、プラン（設計）フェーズにモードを分離しています。

```mermaid
stateDiagram-v2
    [*] --> idle
    
    idle --> planning : `/plan` コマンド<br>または `enter_plan_mode`
    
    planning --> planning : 調査(read-only tools)
    planning --> awaiting_approval : `exit_plan_mode(plan_file)`
    
    awaiting_approval --> approved : ユーザーが[Y]承認
    awaiting_approval --> rejected : ユーザーが[N]拒否 (修正指示)
    
    rejected --> planning : フィードバックを基に再設計
    approved --> idle : 計画に基づき<br>実行用ツール(write等)を解禁
```

### 2.4 Agent Core のその他の主要コンポーネント
- **ContextManager (自動コンテキスト圧縮機能)**
  セッション中のトークン使用量を監視し、`compressionThreshold` (デフォルト80%) を超えた際に動作します。古いメッセージ群をLLM自身に「簡潔に要約」させ、システムプロンプトの直後に『要約された過去の文脈』として挿入することで、無限に続く会話でもコンテキスト上限をオーバーしない仕組みを提供します。
- **SessionManager (セッション永続化)**
  LLMのプロバイダ情報や会話履歴（Tool executionの結果含む）を JSON 形式で `~/.localllm/sessions/` 配下に自動保存・復元し、ターミナルを再起動しても前回の続きから作業を再開できるライフサイクルを管理します。
- **ProjectContext (CLAUDE.md 対応)**
  ワークスペースのルートに `CLAUDE.md` ファイルが存在する場合、それを自動的に検出し、System Promptの一部としてLLMにインジェクションします。これによりプロジェクト固有のコーディング規約や方針をエージェントに遵守させます。
- **Memory (自動記憶機能)**
  会話コンテキストとは独立した永続記憶 (`~/.localllm/memory/MEMORY.md`) を操作します。エージェント自身が必要と判断した知識やユーザーの好みを永続化します。

### 2.5 ツール群の詳細仕様 (Tool Definitions)
本システムには、LLMが自律的に呼び出せる15種類の機能(Function Calling)群が実装されています。

| カテゴリ | ツール名 | 権限 | 機能詳細と動作ロジック |
| :--- | :--- | :--- | :--- |
| **ファイル取得** | `file_read` | auto | 指定されたファイルのテキストを読み込みます。LLMが修正箇所を特定しやすいよう、出力テキストの各行には**行番号を付与**して返却されます。 |
| | `glob` | auto | 指定されたパターン(例:`src/**/*.ts`)に一致するファイル一覧を取得します。ディレクトリ構造の初期探索に用いられます。 |
| | `grep` | auto | 高速な文字列検索を行います。(システムに `ripgrep (rg)` がインストールされていればフォールバックして利用し、なければNode.jsネイティブ実装で検索します) |
| **ファイル更新** | `file_write` | ask | ファイルを新規作成、または全体を上書きします。対象の親ディレクトリが存在しない場合は**自動で `mkdir -p` を実行**します。 |
| | `file_edit` | ask | 既存ファイルの一部分を書き換えます。LLMから渡された `target_string` がファイル内に「一意に存在するか」を厳密にチェックし、合致した場合のみ `replacement_string` に置換します。 |
| **システム** | `bash` | ask | シェルコマンドを実行し、標準出力/標準エラー出力を取得します。無限ループ等のタイムアウト(標準120秒)が設けられています。 |
| **Web検索** | `web_search` | ask | DuckDuckGo等の検索エンジンAPIを用いて、インターネットから最新情報を検索しサマリーを取得します。 |
| | `web_fetch` | ask | 指定されたURLのWebページをダウンロードし、HTMLからプレーンテキスト(Markdown等)を抽出して読み取りやすく整形した結果を返却します。 |
| **ブラウザ操作** | `browser` | ask | **Playwright**プロセスを起動し、指定された操作(`navigate`, `click`, `type`, `snapshot`)を実行します。JavaScriptを多用したSPA等での動作確認やスクレイピングに用いられます。 |
| | `vision` | auto | ブラウザ操作で取得したスクリーンショットやローカル画像を、画像解析専用のサブLLM(OllamaのLlava等)に渡して状態を視覚的に説明させます。 |
| **タスク・補助** | `todo_write` | safe | エージェント自身が行動計画を整理するためのTODOリストをワークスペースに作成・更新します。 |
| | `task` | ask | 自身とは別の独立したコンテキストを持つ**子エージェント (SubAgent)** を生成し、「調査専門」や「コマンド実行専門」などスコープを限定したタスクを裏側(並列)で実行・委譲します。 |
| | `plan_mode` | ask | 破壊的なツール実行を封印し、システムの調査・設計のみを行う「プランモード」に入ります。結果は `.localllm/plans/` に保存されユーザー承認を待ちます。 |
| | `skill` | ask | ユーザーが `.localllm/skills/` 等に配置した独自Markdown形式のスキル（例: git commit, pr review 等の一連の事前定義された操作フロー）を実行します。 |
| | `ask_user` | auto | エージェント単独で判断できない問題や、致命的なエラーが発生した場合にコンソール経由でユーザーに直接質問を投げかけ回答を待ちます。 |

本システムのサンドボックス機構は、OSレベルの仮想化（コンテナ等）ではなく、アプリケーション層（Node.js）での「パスの文字列評価」によるシンプルなアーキテクチャを採用しています。

```mermaid
sequenceDiagram
    participant Tool as Tool (file_read 等)
    participant PM as PermissionManager
    participant Sandbox as Sandbox
    participant OS as File System

    Tool->>PM: 対象パス(targetPath)での操作要求
    PM->>Sandbox: isPathAllowed(targetPath)
    
    Note over Sandbox: 1. パスの正規化<br/>resolved = path.resolve(targetPath)
    Note over Sandbox: 2. 許可リストとの前方一致比較<br/>resolved.startsWith(allowedDir)
    
    alt 許可リストのパスから始まる場合
        Sandbox-->>PM: true (許可)
        PM->>OS: ファイル操作の実行
    else 許可リスト外・不正パスの場合
        Sandbox-->>PM: false (拒否)
        PM-->>Tool: Error: サンドボックス外です
    end
```

### 3.1 許可ディレクトリの初期化
システム起動時、`Sandbox` クラスは以下の領域を安全なディレクトリリスト(`allowedDirs`)としてメモリ上に保持します。
1. `process.cwd()` : エージェントを起動した現在の作業ディレクトリ
2. `os.homedir() + "/.localllm"` : エージェントの挙動を管理する設定領域
3. `config.json` の `allowedDirectories` パラメータで指定された追加パス

### 3.2 評価ロジックと制約
実際のパス解決は `path.resolve()` により相対パス表記（`../`など）を排除した絶対パス文字列を生成し、それが許可リストと前方一致（`startsWith`）するかで判定します。
この「文字列ベースの検査機構」に依存している仕様が原因となり、OS特有のファイルシステム挙動（WindowsのショートパスやUNCパス、Linux/Macのシンボリックリンク等）に対する技術的制約やバイパスリスクを抱えています。リスクの詳細は『セキュリティ評価書 (`security_assessment.md`)』に明記しています。

## 4. インターフェース設計 (クラス構造例)

```mermaid
classDiagram
    class AgentLoop {
        -history: MessageHistory
        -contextManager: ContextManager
        -toolExecutor: ToolExecutor
        +run(userMessage) Promise~void~
        -executeToolsParallel(toolCalls) Promise~void~
    }
    
    class ToolExecutor {
        -registry: ToolRegistry
        -permissions: PermissionManager
        +execute(ToolCall) Promise~ToolResult~
    }

    class BaseProvider {
        <<interface>>
        +chat(options) AsyncGenerator
        +chatWithTools(options) AsyncGenerator
    }

    AgentLoop --> ToolExecutor
    AgentLoop --> BaseProvider
```
