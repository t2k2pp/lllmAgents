# 内部設計書 (Internal Design)

本ドキュメントでは、LocalLLM Agent の内部アーキテクチャ、コンポーネント間のデータの流れ、およびツール・権限管理の実装詳細について定義します。

## 1. 全体アーキテクチャ

システムは大きく分けて以下の主要コンポーネントから構成されています。

### 1.1 CLI & REPL 層 (`src/cli/`)
- `repl.ts` / `renderer.ts`
  - ユーザーからの入力を受け付け、スラッシュコマンド(`.ts`側)と自然言語プロンプトのパースを行います。
  - Markedライブラリ等を用いた美しいターミナル出力を担当します。

### 1.2 Agent Core 層 (`src/agent/`)
- **AgentLoop (`agent-loop.ts`)**
  - アプリケーションのメインループです。ユーザーの入力を受け、LLMプロバイダに推論をリクエストし、必要に応じてツール呼び出し（Tool Call）を解釈・実行します。
  - 複数のツール呼び出し要求がある場合は `Promise.allSettled()` にて並列実行し、レスポンス速度を最適化しています。
- **ContextManager (`context-manager.ts`)**
  - セッション中のコンテキスト（トークン）使用量を監視し、上限（デフォルト80%）に達した際にLLM自身による過去履歴の要約・圧縮を実行します。
- **PlanManager (`plan-mode.ts`)**
  - タスクの事前設計を行うプランモードの状態管理（`idle` → `planning` → `awaiting_approval` → `approved` / `rejected`）を行います。プランモード中はファイル変更系のツール実行が自動的に制限されます。
- **SubAgentManager (`sub-agent.ts`)**
  - タスク処理を委譲するための子エージェントの作成・ライフサイクル・バックグラウンド実行を管理します。

### 1.3 Tools & Skills 層 (`src/tools/` & `src/skills/`)
- **ToolRegistry & ToolExecutor**
  - 約22種類のツール（ファイル操作、シェル実行、ブラウザ操作、サブエージェント等）の宣言とディスパッチを行います。
- **SkillLoader & SkillRegistry (`skill-registry.ts`)**
  - プロジェクト固有（`.claude/skills/`等）、またはグローバル（`.localllm/skills/`）に定義された拡張スキル（Markdown形式のプロンプト・フロー）をロードし、ツールとしてLLMに提示します。

### 1.4 Security 層 (`src/security/`)
- **PermissionManager (`permission-manager.ts`)**
  - ツールの実行権限（`auto`, `ask`, `deny`）を判定し、必要に応じてユーザーに承認プロンプト(`inquirer`)を表示します。「セッション中常に許可」のキャッシュ管理も行います。
- **Sandbox (`sandbox.ts`)**
  - ファイルパスを正規化・評価し、操作対象が許可されたディレクトリ（CWD, HOME, /tmp など）内に存在するかを検証します。
- **SecurityRules (`rules.ts`)**
  - `bash` ツール実行時に、危険なコマンド（`rm -rf /` 等）を正規表現パターンで検査し、ブロックまたは警告を行います。

### 1.5 Provider 層 (`src/providers/`)
- `openai-compat.ts`, `ollama.ts`, `lmstudio.ts`, `vllm.ts`, `llamacpp.ts`
  - `BaseProvider` インターフェースを実装し、各ローカルAPIの差異を吸収して統一的なストリーミングチャットAPIおよびTool calling APIを上位レイヤーに提供します。

## 2. データフロー

1. **入力**: REPLがユーザー入力を受け取り、AgentLoopにメッセージとして渡す
2. **コンテキスト評価**: `ContextManager`が現在のトークン消費量をチェックし、リミットを超えていれば圧縮処理を非同期に走らせる
3. **推論**: LLM Providerがメッセージ履歴とTool Definitionsを付与してチャット生成リクエストを送信
4. **Tool Callパース**: LLMからのレスポンス内にツール呼び出しが含まれていれば、`ToolExecutor` にディスパッチ
5. **権限・サンドボックス確認**: `PermissionManager` がツールと引数を評価。要確認の場合はCLIにプロンプトを提示
6. **ツールの並列実行**: `AgentLoop` にて複数のツールが並列(`Promise.allSettled`)で実行され、結果が履歴に追加される
7. **結果返却**: ツール実行結果を踏まえて再度LLMにリクエストが送られ、最終的な回答としてREPLにストリーミング出力される
