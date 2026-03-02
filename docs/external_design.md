# 外部設計書 (External Design)

本ドキュメントでは、LocalLLM Agent の外部仕様（ユーザー向け機能・インターフェース・動作要件）について定義します。

## 1. システム概要

LocalLLM Agent は、ローカルで稼働するLLM（大規模言語モデル）を活用した**CLI型AIエージェント**です。ユーザーのPC上で自律的に動作し、ファイルの読み書き、Web検索、ブラウザ操作、コマンドの実行などを通じてタスクを遂行します。Claude Code にインスパイアされた対話型の REPL インターフェースを提供します。

### 1.1 主な特徴とユースケース

```mermaid
mindmap
  root((LocalLLM Agent))
    ローカル実行
      Ollama
      LM Studio
      llama.cpp
      vLLM
    自律操作
      ファイルI/O
      ターミナル実行
      Webブラウジング
      検索と要約
    セキュア設計
      3層権限モデル
      コマンドブロック
      制限つきサンドボックス
    UX最適化
      REPLインタフェース
      スラッシュコマンド
      自動コンテキスト圧縮
```

```mermaid
usecase
  %% ユーザーとエージェント間のインタラクション概要
  actor User as "ユーザー"
  
  package "LocalLLM Agent" {
    usecase "REPL対話" as UC1
    usecase "コマンド操作(/help等)" as UC2
    usecase "ファイル編集・検索" as UC3
    usecase "OSコマンド実行(bash)" as UC4
    usecase "Web操作(Playwright)" as UC5
    usecase "プランモード(タスク設計)" as UC6
  }
  
  User --> UC1
  User --> UC2
  User --> UC6
  
  UC1 ..> UC3 : "LLM自律判断"
  UC1 ..> UC4 : "LLM自律判断"
  UC1 ..> UC5 : "LLM自律判断"
  
  note right of UC4
    ※実行前にユーザーの承認(Ask)またはブロック(Deny)が発生
  end note
```

## 2. ユーザーインターフェース (UI)

### 2.1 REPL コマンドラインUI
エージェントはターミナル上で動作し、コマンドプロンプト形式でユーザーの自然言語入力を受け付けます。

```mermaid
stateDiagram-v2
    [*] --> Idle
    
    Idle --> Typing : キー入力
    Typing --> MultiLine : "```" (バッククォート3つ)
    MultiLine --> Typing : "```" で閉じる
    Typing --> Processing : Enter押下
    
    Processing --> Streaming : LLM推論中
    Streaming --> ToolExecution : ツール呼び出し検出
    ToolExecution --> PermissionCheck : 状態変更操作
    
    PermissionCheck --> ToolExecution : ユーザー承認 (y/always)
    PermissionCheck --> Processing : ユーザー拒否 (n)
    
    ToolExecution --> Processing : 結果のフィードバック
    Streaming --> Idle : 回答完了
    
    Processing --> Idle : Ctrl+C (キャンセル)
    ToolExecution --> Idle : Ctrl+C (キャンセル)
```

### 2.2 スラッシュコマンド一覧

| コマンド | 説明 |
|----------|------|
| `/help` | ヘルプや使用可能なコマンド一覧を表示します |
| `/quit` | エージェントを終了します |
| `/clear` | 現在の会話履歴とコンテキストをクリアします |
| `/context` | 現在のコンテキスト（トークン）使用状況を表示します |
| `/setup` | 設定ウィザードを再実行し、LLMプロバイダーやモデルを変更します |
| `/plan` | タスクを事前に分析・設計する「プランモード」を手動で開始します |
| `/skill` | 追加ロードされているスキル（builtin含む）の一覧を表示します |
| `/agents` | バックグラウンド等で稼働しているサブエージェントの一覧・状態を表示します |
| `/status` | 全体の稼働ステータス（コンテキスト・タスク・エージェント）を一括表示します |

## 3. 提供機能とツール群

エージェントはLLMの推論結果に基づき、以下の機能（ツール）を抽象化された関数(Function Calling)として呼び出します。

```mermaid
graph TD
    classDef safe fill:#d4edda,stroke:#28a745,color:#155724;
    classDef ask fill:#fff3cd,stroke:#ffc107,color:#856404;
    
    subgraph Filesystem [ファイル操作]
        F1(file_read):::safe
        F2(glob / grep):::safe
        F3(file_write):::ask
        F4(file_edit):::ask
    end
    
    subgraph System [システム操作]
        S1(bash):::ask
    end
    
    subgraph Web_Browser [Web・ブラウザ操作]
        W1(web_search / web_fetch):::ask
        W2(browser_navigate / click / type):::ask
        W3(browser_snapshot):::ask
    end
    
    subgraph SubAgents [タスク・エージェント管理]
        A1(todo_write):::safe
        A2(task):::ask
        A3(skill):::ask
    end
```
※緑色: 自動許可(`auto`)、黄色: 確認必須(`ask`)

## 4. セキュリティ・権限モデルのUXフロー

```mermaid
sequenceDiagram
    actor U as ユーザー
    participant CLI as CLI/REPL
    participant PM as PermissionManager
    participant Tool as Target Tool

    U->>CLI: 「package.jsonを書き換えて」
    CLI->>PM: 対象ツールのディスパッチ (file_edit)
    
    PM->>PM: 権限レベルチェック (ask)
    PM->>PM: サンドボックス判定
    alt サンドボックス外・危険コマンド
        PM-->>CLI: Action Blocked (Deny)
        CLI-->>U: エラーメッセージ表示
    else 許可されたスコープ内
        PM-->>U: 実行を許可しますか？ [O(nce)/A(lways)/D(eny)]
        U->>PM: ユーザー応答
        alt D(eny)
            PM-->>CLI: Action Rejected
        else O(nce) or A(lways)
            PM->>PM: (A)の場合セッションにキャッシュ
            PM->>Tool: 実行
            Tool-->>CLI: 実行結果
        end
    end
```

## 5. 設定と環境要件

- **要件**: Node.js 18+
- **LLM**: ローカルLLM環境（Ollama等）の起動
- **設定ロケーション**: `~/.localllm/config.json`
- **主要な設定値**:
  - `providerType`: `ollama`, `lmstudio`, `llamacpp`, `vllm`, `openai-compat`
  - `contextWindow`: トークン上限。これの80%(デフォルト)に達すると自動圧縮。
  - `allowedDirectories`: サンドボックスでアクセスを許可する追加のディレクトリリスト。
