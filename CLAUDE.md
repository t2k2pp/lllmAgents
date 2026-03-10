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
- src/agent/       - エージェントループ、サブエージェント、プランモード、セッション、メモリ
- src/agents/      - エージェント定義ファイル (.md) とローダー
- src/tools/       - ツールレジストリ、エグゼキュータ、21ツール定義
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
- タスク必ずToDo化してToDoを確認しながら進める
- ToDoには概要レベルの設計思想も構造化して含める
- 機能追加を行う場合はdocs配下に設計書作成し、設計書と実装の整合性を常に保つ
- 参考資料と成果物を区別し、不要なものをリポジトリに入れない
- 作成するアプリ内の処理でファイルアクセスは相対パスは誤操作の元になるので禁止、絶対パスを使う事
