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

## Claude Codeによるデバッグ・テスト作業のガイドライン

### 非TTYパイプモードの使い方と制約

lllmAgentsを自動テストするとき、以下のパイプ方式が使える：

```bash
printf "/model qwen3.5:122b\nプロンプト内容\n2\n1\n1\n...\n/quit\n" \
  | NODE_OPTIONS="--max-old-space-size=8192" npm run start > output/task.log 2>&1 &
```

**権限確認ダイアログの数値入力：**
- `1` = 今回のみ許可
- `2` = セッション中は常に許可（繰り返し使用時に推奨）
- `4` = 今回のみ拒否
- `5` = 中止（3は config.json を永続変更するため禁止）

**制約と注意事項（必読）：**
1. **使用前に明示宣言すること** — パイプモードで動かす場合は、作業開始時にユーザーに「長時間待機ができないためパイプモードで実行する」と伝える
2. **REPL対話品質が検証できない** — パイプモードはQ→A応答のミスマッチ（例：ゲームキー入力がチャットに混入）を検知できない。対話品質が重要な変更後はTTYでの手動確認が必要
3. **アウトプット品質の確認ができない** — 中間出力を見ながら方向修正する機会がない。長時間タスクは定期ログ確認ループを組み合わせること

### 長時間タスクへの推奨アプローチ

アプリに長時間タスク（書籍生成など）を投げる場合：
- ❌ 大量のプリセット応答をパイプして放置
- ✅ **Claude Code のScheduled Tasks機能** を使って定期ログ確認・追加指示を自動化する

#### Scheduled Tasks を使った自動監視パターン（推奨）

Claude Code には `mcp__scheduled-tasks__` ツールがあり、cron式で定期実行できる。
長時間タスクはこれを組み合わせることで、コンテキスト切れ・長時間待機の問題を回避できる。

```
# 1. アプリをバックグラウンド起動（最初のプロンプトのみ）
printf "最初のプロンプト\n2\n" | npm run start >> output/task.log 2>&1 &

# 2. Scheduled Taskで30分ごとにログを確認・評価・追加指示
create_scheduled_task(
  taskId: "book-progress-checker",
  cronExpression: "*/30 * * * *",
  prompt: """
    output/book-v1-gen.log の末尾100行を確認して：
    - 生成完了していれば品質評価（散文か？2000字以上か？）を報告
    - 品質不足なら改善指示をパイプで追加送信
    - エラーが出ていればバグ報告
  """
)
```

このアプローチにより：
- Claude Codeの知識・判断をアウトプット品質に反映できる
- コンテキスト上限で会話が切れても監視が継続する
- Q→A対話の中間品質を確認・方向修正できる

### モデル切り替えのベストプラクティス

- `/model <name>` コマンドをパイプ先頭行に含めることでランタイム切り替え可能
- 大型MoEモデル（qwen3.5:122b等）は初回ロードに60分超かかる場合がある
  - タイムアウト設定: `DEFAULT_STREAM_CONNECT_TIMEOUT = 7_200_000`（2時間）
  - ヒープ増量: `NODE_OPTIONS="--max-old-space-size=8192"`
- モデル選定指針:
  - qwen3.5:122b (MoE, 75GB) — 高品質・長文生成に最適
  - qwen3.5:27b (Dense, 16GB) — 速度重視・短時間タスク向け
