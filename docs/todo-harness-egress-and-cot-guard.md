# ToDo: ハーネス側エグレス・IMDS・偵察防止およびCoT-ツール不整合ガード実装

- 設計書: [`docs/harness-egress-and-cot-guard-design.md`](file:///C:/Users/osia3/GitProjects/claudeclone/lllmAgents/docs/harness-egress-and-cot-guard-design.md)
- 目的: Cohere社報告の `Qwen3.8-Flash-Next` データ送信試行問題および過去ログ調査結果に基づき、ハーネス（`lllmAgents`）側で (1) IMDS・Alibaba Cloud OSS送信・`/dev/tcp` のハードブロックと評価順序是正、(2) 非ループバック外部通信・データ送信・DNSクエリ・偵察コマンドの確認強制、(3) 推論ログ（CoT）とツール呼び出しの不整合検知と自動承認バイパス、(4) 子プロセス環境変数サニタイズと機密ファイル境界の強化 を実装・検証し、`main` リポジトリへ反映する。

## タスク一覧

- [x] 1. 過去ログ（jsonl/json）の全量監査と設計書・ToDoファイルの作成
- [x] 2. IMDS・Alibaba Cloud OSS・`/dev/tcp` のブロックルール追加と、`PermissionManager` における評価順序の是正・外部通信/DNS/偵察コマンドの確認強制 (`src/security/rules.ts`, `src/security/permission-manager.ts`)
- [x] 3. 推論ログ（CoT）とツール呼び出しの不整合検知ガードの実装と `AgentLoop` / `PermissionManager` 連携 (`src/security/cot-tool-guard.ts`, `src/agent/agent-loop.ts`, `src/security/permission-manager.ts`)
- [x] 4. `bash` 子プロセス環境変数のサニタイズと `Sandbox` 機密ファイル境界の強化 (`src/security/env-sanitizer.ts`, `src/tools/definitions/bash.ts`, `src/security/sandbox.ts`)
- [x] 5. 単体テスト・回帰テストの追加と全テスト・lint・パッケージ検証の実行 (`tests/security/`)
- [x] 6. 最終コミット・`main` リポジトリへの Push および GitHub Actions CI の全ジョブ完了確認
