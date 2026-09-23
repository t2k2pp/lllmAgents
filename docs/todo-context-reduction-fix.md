# ToDo: コンテキスト削減（忘却・圧縮）における思考モデル対応および空応答ハンドリング改善

- 課題ID: `FIX-CONTEXT-REDUCTION-01`
- 目的: 思考モデル使用時における忘却（forget）および階層圧縮（compact）の空応答（`outputChars=0`）の根本解消、`openai-compat` における `finishReason` 保持修正、および応答サイズ0の早期ガードの実装

## タスク一覧

- [x] 1. 設計とToDoの作成
  - [x] 設計書（`docs/context-reduction-reasoning-model-fix.md`）の作成
  - [x] ToDoファイル（`docs/todo-context-reduction-fix.md`）の作成
- [x] 2. プロバイダー層の修正 (`src/providers/openai-compat.ts`)
  - [x] `lastFinishReason` の追跡保持
  - [x] `data: [DONE]` 時に `lastFinishReason` を保持して返却（無条件 `"stop"` 上書きの解消）
  - [x] 単体テストの追加 (`tests/providers/openai-compat-finish-reason.test.ts`)
- [x] 3. 忘却エンジンの修正 (`src/agent/forgetting.ts`)
  - [x] `FORGET_MAX_TOKENS` の適正化（600 → 1,500）
  - [x] プロンプト・システム指示への思考最小化ディレクティブ追加
  - [x] 応答サイズ 0 の早期判定ガード（空応答時にパースを呼ばず原因明示）
  - [x] 単体テストの検証・更新 (`tests/agent/forgetting.test.ts`)
- [x] 4. 階層圧縮エンジンの修正 (`src/agent/hierarchical-compressor.ts`)
  - [x] `COMPRESSOR_LAYER1_MAX_TOKENS`（1,000 → 2,000）、`COMPRESSOR_LAYER2_MAX_TOKENS`（1,500 → 2,500）の適正化
  - [x] 要約プロンプトへの思考最小化ディレクティブ追加
  - [x] 応答サイズ 0 の早期判定ガード（空応答時にパースを呼ばず原因明示）
  - [x] 単体テストの検証・更新 (`tests/agent/hierarchical-compressor-failure.test.ts`, `tests/agent/handoff-recovery.test.ts`)
- [x] 5. ローカル品質検証
  - [x] TypeScript ビルド (`npm run build`)
  - [x] 全単体テストの実行 (`npm test`)
  - [x] 配布バイナリの再ビルド (`npm run build:deploy`)
  - [x] 実機（`llama.cpp` / `Qwen3.8-Flash-Next`）を用いたプロンプト再現および結合動作検証
- [x] 6. 完了報告と成果物の提示
