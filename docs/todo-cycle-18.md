# ToDo: cycle 18 Durable Run Resume 実装・評価・CI閉鎖

- 課題ID: `GAP-DURABLE-RUN-01`
- 目的: PC・アプリ再起動を跨ぐ durable run resume の安全な境界での永続化・再開・評価完了と最新SHA CI監視

## タスク一覧

- [x] 1. 設計・差分・機能削除の整合性精査
  - [x] 設計書（`docs/durable-run-resume-design.md`）および比較マトリックス（`docs/product-feature-comparison-cycle-18-durable-run-resume-2026-09-03.md`）の整合性確認
  - [x] 意図しない処理の削除がないことの確認
  - [x] `sandbox/` 等のユーザー所有資産が除外されていることの確認
- [x] 2. ローカル品質ゲート検証
  - [x] 2.1 Gitフック設定 (`npm run setup:git-hooks`)
  - [x] 2.2 TypeScriptビルド (`npm run build`)
  - [x] 2.3 対象ユニット・統合テストの実行 (5 files, 30 tests passed)
  - [x] 2.4 cross-process 再起動スモーク (`npm run test:durable-restart` passed)
  - [x] 2.5 Lint検査 (`npm run lint` passed)
  - [x] 2.6 カバレッジ・全ユニットテスト (`npm run test:coverage` 130 files / 1331 tests passed)
  - [x] 2.7 E2Eテスト (`npm run test:e2e` 7 tests passed)
  - [x] 2.8 スキル・バージョン・パッケージ検証 (`npm run validate:skills`, `validate:version`, `validate:package` passed)
  - [x] 2.9 依存性セキュリティ監査 (`npm audit --package-lock-only --omit=dev --audit-level=high` 0 vulnerabilities)
  - [x] 2.10 Windows配布ビルド検証 (`npm run build:deploy` passed, `deploy/localllm.exe --version` passed)
- [x] 3. ドキュメントおよび品質記録の更新
  - [x] テスト実測値・設計仕様の整合確認
- [x] 4. コミット作成
  - [x] 変更対象ファイルのみステージング（sandbox除外）
  - [x] AGENTS.md規約（背景 / 変更 / 検証）に準拠したコミットメッセージ
- [x] 5. リモートリポジトリへのPush
  - [x] `git push origin main`
- [x] 6. 最新SHAのCI完了監視
  - [x] GitHub Actions ワークフロー（Ubuntu, macOS, Windows tests, macOS real PTY, Windows deploy / exe smoke）の全ジョブ完了確認 (CI 33748152471 passed)
- [x] 7. 完了確認と報告
