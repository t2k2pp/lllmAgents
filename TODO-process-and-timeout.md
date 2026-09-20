# ToDo: プロセス分離・タイムアウト刷新・対話デッドロック防止

## 前提情報
- 対象リポジトリ: `https://github.com/t2k2pp/lllmAgents.git` (branch: main)
- 設計書: `docs/fix-plan-process-and-timeout-management.md`
- 各タスク完了ごとにテストを実行し、リモートリポジトリへコミット・プッシュを格納する。

---

## タスク一覧

- [x] **Task 1: 非対話環境変数（Fail-Fast）と TTY 遮断（`detached: true`）の導入**
  - 対象: `src/tools/definitions/bash.ts`
  - 内容:
    1. `childEnv` に `GIT_TERMINAL_PROMPT="0"`, `CI="1"`, `DEBIAN_FRONTEND="noninteractive"`, `NPM_CONFIG_YES="true"`, `PIP_NO_INPUT="1"` を常時注入。
    2. POSIX（macOS/Linux）において `spawn()` に `detached: true` を設定し、制御端末（`/dev/tty`）から子プロセスを切り離す。
  - 検証:
    - `GIT_TERMINAL_PROMPT=0` が効いて未認証 Git コマンドが即座にエラー終了することを確認。
    - 単体テスト `tests/tools/bash.test.ts` の実行。
  - 格納: リモートリポジトリにコミット・プッシュ。

- [x] **Task 2: プロセスグループ全体を確実に終了する `killProcessTree` の刷新**
  - 対象: `src/tools/definitions/bash.ts`
  - 内容:
    1. POSIX 環境で `process.kill(-pid, "SIGTERM")` を送信し、一定時間後に `SIGKILL` を送るプロセスグループ強制終了ロジックを実装。
    2. 安全ガード（`pid > 1`, `pid !== process.pid`）を厳格に適用。
  - 検証:
    - シェルから起動された孫プロセス（バックグラウンドで sleep や git を動かすコマンド）が確実に親諸共 kill されるテストを作成・検証。
  - 格納: リモートリポジトリにコミット・プッシュ。

- [x] **Task 3: アイドルタイムアウト（無通信監視）と長時間タスク進行監視の実装**
  - 対象: `src/tools/definitions/bash.ts`
  - 内容:
    1. `idleTimeout`（無通信タイムアウト、デフォルト 60秒）の導入。
    2. stdout / stderr にデータが受信される限りタイマーをリセットし、正常に進行している長時間タスクを不当に切断しないように改善。
    3. 30秒以上の長時間タスクに対する進行ハートビートログの追加。
    4. ハードリミット `timeout` の扱いを整理（明示指定時は優先、未指定時はアイドル監視メイン）。
  - 検証:
    - 定期的に出力がある長時間コマンドがタイムアウトせず完走することを確認。
    - 出力が途絶えたデッドロックコマンドが `idleTimeout` で適切に検知されることを確認。
    - 単体テストの追加と実行。
  - 格納: リモートリポジトリにコミット・プッシュ。

- [x] **Task 4: AskUser / PermissionManager の対話プロンプト堅牢化の確認**
  - 対象: `src/security/permission-manager.ts`, `src/cli/prompt-gate.ts`, `src/tools/definitions/ask-user.ts`
  - 内容:
    1. プロンプト表示時に stdin が不正状態だった場合の例外安全性の検証。
    2. Ctrl+C による中断時のシグナルハンドリング（ExitPromptError / force closed）が確実に作動するよう ask-user.ts に保護を追加。
  - 検証:
    - 自動テストおよび手動対話の結合テスト実行。
  - 格納: リモートリポジトリにコミット・プッシュ。

- [x] **Task 5: 全体結合テストとドキュメント更新**
  - 内容:
    1. 既存の全テストスイート（`npm test`）の実行と合格確認。
    2. ソースコード量の差分確認（意図しないコード削除がないかの確認）。
    3. CHANGELOG またはドキュメントの更新。
  - 格納: リモートリポジトリにコミット・プッシュ。
