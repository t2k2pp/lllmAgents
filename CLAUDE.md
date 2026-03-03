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
- タスクが発生したら必ずToDo化してテキストに残す
- ToDoには思い出すのに十分な詳細情報を含める（コンテキスト圧縮後でも復元可能にする）
- マストのタスクが圧縮で埋もれないようにする
- 不要なものをリポジトリに入れない（参考資料と成果物を区別する）
- 設計書と実装の整合性を常に保つ
