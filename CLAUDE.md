# CLAUDE.md - lllmAgents

## Project Overview
ローカルLLM（Ollama, LM Studio, llama.cpp, vLLM）で動作するCLIベースのAIエージェント。
Claude Codeの姉妹アプリとして設計。
Repository: https://github.com/t2k2pp/lllmAgents.git

## Build & Run
```bash
npm run build        # TypeScript コンパイル
npm run dev          # 開発モード (tsx)
npx tsc --noEmit     # 型チェックのみ
```

## Architecture
- src/agent/       - **コアロジック**: AgentLoop, PlanManager, ContextManager, MessageHistory, SystemPrompt（TypeScriptコード）
- src/agents/      - **エージェント定義**: サブエージェントの役割を定義する .md ファイル群とローダー（agent/ とは別物）
- src/tools/       - ツールレジストリ、エグゼキュータ、23ツール定義
- src/providers/   - LLMプロバイダー (Ollama, LMStudio, llama.cpp, vLLM)
- src/cli/         - REPL、レンダラー
- src/hooks/       - Pre/PostToolUse, Session lifecycle hooks
- src/rules/       - 常時適用ルール (builtin + user + project)
- src/context/     - コンテキストモード (dev/review/research)
- src/skills/      - スキルシステム (builtin + user + project)
- src/security/    - 権限管理、サンドボックス
- src/config/      - 設定管理、セットアップウィザード
- src/browser/     - Playwright統合
- docs/            - 設計書 (external_design.md, internal_design.md, security_assessment.md)

## User Rules (ユーザーとの約束)
- タスクは必ずToDo化してToDoを確認しながら進める
- ToDoには概要レベルの設計思想も構造化して含める
- 機能追加を行う場合はdocs配下に設計書を作成し、設計書と実装の整合性を常に保つ
- 参考資料と成果物を区別し、不要なものをリポジトリに入れない
- アプリ内のファイルアクセスは絶対パスを使う（相対パス禁止）

## Claude Codeによるデバッグ・テスト作業のルール

### 非TTYパイプモード
- パイプモードで実行する場合は、作業開始時にユーザーへ事前宣言する
- REPL対話品質（Q→A応答の対応、UX）はパイプモードでは検証できない。対話品質に関わる変更後は手動TTY確認が必要
- 権限確認の数値: `1`=今回のみ許可、`2`=セッション中常に許可、`4`=拒否、`5`=中止（`3`は永続変更のため禁止）

### 長時間タスク
- 長時間タスクはScheduled Tasks（`mcp__scheduled-tasks__`）で30分ごとにログ確認・追加指示を自動化する
- 確認間隔は処理時間に関わらず30分以下に保つ（詳細: docs/internal_design.md §10）

### モデル
- 起動後の切り替え: `/model <name>`
- 大型モデル（122b等）: `NODE_OPTIONS="--max-old-space-size=8192"` でヒープ増量が必要な場合あり
