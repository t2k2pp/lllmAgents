# ToDo: cycle 19 モデルパス対応能力Tier解決および起動時例外可視化

- 課題ID: `FIX-STARTUP-CAPABILITY-01`
- 目的: `sandbox/run.sh` 実行時のサイレントクラッシュの解消（エラー可視化）、パス付きモデル名（GGUF等）とQwen Flash/Next系のTier自動解決、および `deploy/localllm` の再ビルド・検証とコミット・プッシュ・CI監視

## タスク一覧

- [x] 1. 設計とToDoの作成・確認
  - [x] 設計書（`docs/model-path-capability-and-startup-error-fix.md`）の作成
  - [x] ToDoファイル（`docs/todo-cycle-19-model-path-capability-and-startup-error-fix.md`）の作成
- [x] 2. 起動時例外可視化の改善 (`src/index.ts`)
  - [x] Alternate Screen終了（`restoreOutput`）後にエラーを出力するように修正
  - [x] 診断性向上のため `writeCrashLog` も連携
- [x] 3. パス付きモデル名および Qwen Flash/Next 系の能力 Tier 自動判定 (`src/agent/capability-tier.ts`)
  - [x] パス付きモデル名から basename や親ディレクトリ名を抽出する候補生成ロジックの実装
  - [x] `PATTERN_RULES` への `Qwen3.*-?(flash|next|turbo)` パターン追加（Tier: T2）
- [x] 4. `AgentLoop.getCapabilityOverride` の改善 (`src/agent/agent-loop.ts`)
  - [x] フルパスだけでなく basename / 親ディレクトリ名での `modelCapabilities` マッチ対応
- [x] 5. 単体テストの追加と既存テストの検証
  - [x] `tests/agent/capability-tier.test.ts` にパス付きモデル名・Qwen3.8-Flash-Next のテストを追加
  - [x] 単体テスト実行 (`npm test tests/agent/capability-tier.test.ts`)
- [x] 6. ビルドおよびローカル品質ゲートの検証
  - [x] TypeScript ビルド (`npm run build`)
  - [x] 全テスト実行 (`npm test`)
  - [x] 配布バイナリ再ビルド (`npm run build:deploy`)
  - [x] `sandbox/run.sh` の動作検証
- [ ] 7. コミット・プッシュ・CI監視
  - [ ] 変更ファイルのステージング
  - [ ] コミット作成（背景・変更・検証のフォーマット準拠）
  - [ ] リモートリポジトリへのプッシュ (`git push origin main`)
  - [ ] GitHub Actions ワークフロー完了監視
- [ ] 8. ユーザーへの報告
