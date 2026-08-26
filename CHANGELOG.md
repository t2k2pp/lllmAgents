# Changelog

このファイルはリリースごとの主要な変更を記録する。形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、バージョンは semver。リリース時は `package.json` / `src/version.ts` のバージョンを揃え、`v<version>` タグを打つ (docs/production-readiness.md PR-12)。

## [Unreleased]

### Codex / Claude Code 機能比較サイクル (2026-08-26)

- Codex / Claude Code / lllmAgents の機能比較マトリックスを追加
- カスタムagent frontmatterの`skills`と`task.skills`で、サブエージェントへスキル全文を起動時preload可能にした
- preload対象のskillが存在しない、または無効な場合はモデル起動前に明示エラーとし、`${SKILL_DIR}`とsandbox許可を正しく解決
- `schedule_create` / `schedule_list` / `schedule_delete`を追加し、モデルが現REPL sessionへ一回／反復promptを登録・確認・取消可能にした
- `task_list` / `task_cancel`を追加し、background sub-agentの実行中・完了・失敗・取消状態を確認して不要な実行を停止可能にした
- `task_send`を追加し、実行中background sub-agentへFIFOの追加指示を送り、古いLLM生成・未実行tool callを安全に再steer可能にした
- 明示したローカルplugin bundleからskills・agents・hooks・MCPを一括ロードし、Codex / Claude互換manifest、名前空間化、root外path拒否に対応
- `--safe-mode`を追加し、壊れたplugin・skill・hook・MCP・project指示・memory・custom agent/ruleを読み込まず診断・復旧できるようにした
- sub-agentのLLM生成へ中断signalを伝播し、完了済みtaskを結果回収までrunningと誤表示する状態管理を修正
- sub-agentが最大turn到達で最終回答を作れなかった場合に成功・完了と誤表示する状態判定を修正
- `/loop`のasync timerでrunner例外が未処理rejectになる問題と、長時間runnerの重複実行を修正。busy時のone-shotは延期して消失を防止
- UUID先頭8文字が数字だけの場合にモデル登録のID前方一致が範囲外一覧番号と誤判定される不具合を修正

### 商品品質レビューサイクル 2 (2026-08-25)

- シェルのUTF-8出力がマルチバイト文字のチャンク境界で文字化けする不具合を修正
- 非UTF-8またはfrontmatter不正のスキルを黙って無視せず、対象パスと原因を警告
- `product-quality-cycle` スキルへ Windows PowerShell のUTF-8明示読取規則を追加

### 商品品質レビューサイクル 1 (2026-08-24)

- 配布物へ組み込みエージェント定義を同梱し、exe で `general-purpose` / `explore` 等が見つからない不具合を修正
- サブエージェントのトークン・キャッシュ・推定コストを `/cost` の共通台帳へ計上
- `/model` 即時切替後の live binding を同期し、設定未反映の誤警告を修正
- Windows の Goal Loop チェック実行と timeout 時のプロセスツリー終了を修正
- HTTP 接続失敗・Web ツール失敗時に残るタイマーと AbortSignal listener を解放
- ループ分析から内部・test sessionを除外し、promptをopt-in、home path・tool引数値をredact
- 組み込み `product-quality-cycle` スキルを追加し、観点指定のレビュー・設計・実装・評価・記録を再実行可能化

### 製品品質 (docs/production-readiness.md P3+P4)

- ログ・セッションの世代管理: 起動時に古い ops/LLM I/O ログ (既定30日) とセッション (既定100件超過分) を告知つきで削除。`logging.retention` で調整可能 (PR-15)
- シークレット分離: API キー・Bot/App トークン・Webhook URL を `~/.localllm/credentials.json` (自ユーザーのみ) へ分離。旧 config.json からは初回起動時に自動移行 (PR-04 方針2)
- カバレッジ可視化: `npm run test:coverage` と CI レポート出力 (閾値ゲートなし) (PR-09)
- REPL コマンドレジストリ: `src/cli/commands/` に1コマンド=1ファイル方式を新設。補完・/help を自動生成し、`/parallel` `/autorun` `/loglevel` を移設 (PR-10 漸進移行の基盤)
- `/doctor` 環境診断コマンド: LLM接続 / Playwright / Discord / Slack / 画像生成 / ディスク使用量を読み取り専用で一括チェック (PR-16)
- 更新通知: 起動時に GitHub の最新リリースを確認し、新しければ1行通知 (TTY のみ、`updateCheck.enabled: false` でオフ) (PR-14)
- 配布物の初回警告案内: SmartScreen / Gatekeeper の回避手順を deploy README と install.bat に追記。署名は個人配布の間は見送りを決定 (PR-13)
- docs 索引: `docs/README.md` で 70+ 本の設計書を Status 付きで分類。issues.md は棚卸しして凍結 (PR-11)

## [0.4.0] - 2026-07-04

v0.3.0 の後にリリースなしで main へ積まれていた変更のまとめ (CHANGELOG 導入に伴う初回ロールアップエントリ)。

### 製品品質 (docs/production-readiness.md P1+P2)

- グローバル例外ハンドラ: クラッシュ時にセッション緊急保存→端末復元→`~/.localllm/logs/crash/` へレポート出力 (PR-01)
- config/セッションのアトミック書き込みと、破損時の退避・`.bak` 復元・告知つきリカバリ (PR-02)
- config.json の zod スキーマ検証: 型の合わないフィールドを警告つきで無視 (PR-03)
- シークレット保護: config.json のファイル権限制限 (chmod 600 / icacls) と webhook URL の表示マスク (PR-04 一部)
- 依存脆弱性の解消と CI audit ゲート、Dependabot 週次更新 (PR-05)
- CI マトリクスに windows-latest を追加 (PR-06)
- Biome 導入: format 全体適用と lint (既存違反ルールは warn から開始) (PR-07)
- E2E スモークテスト: モック LLM + 非TTYパイプモードでアプリ全体を起動検証 (`npm run test:e2e`) (PR-08)
- バージョン管理: CHANGELOG 導入、起動バナー・`--version`・クラッシュログにコミットハッシュ表示 (PR-12)

### 主な機能追加 (v0.3.0 以降)

- Discord 連携: Webhook 通知、Slash Command 受信 (Gateway/WS 方式)、権限確認ブリッジ
- Slack 連携: Socket Mode Bot (`--slack`)、通知、権限ブリッジ
- Room モデル: REPL/Discord/Slack のサーフェス別セッション分離と自動 resume
- Model Registry: 接続設定の登録・main/second スロット割当・`/model` 系コマンド
- セカンド LLM: 相談 (consult) / タスク委任 (agent) / 成果物レビュー (evaluator)
- OS サンドボックス: macOS Seatbelt / Linux bwrap、ネット allowlist プロキシ、封じ込め時の bash 自動許可
- 自動チェックポイント (シャドウ Git) と `/checkpoint` コマンド、`game_smoke` ツール
- スキルシステム (ビルトイン+ユーザー)、MCP サーバー接続、サブエージェント
- 画像生成 (Azure GPT Images / SD WebUI / ComfyUI)、vision 解析
- Goal Seek モード、戦略 ToDo、自己点検ループ、能力ティア別ハーネス
- コスト追跡 (トークン・予算・円換算表示)、運用ログ (ops JSONL)・LLM I/O ログ
- exe 配布 (SEA ビルド、Playwright 外部化、`--install-browser`)

## [0.3.0] - 2026-03 以前

初期リリース系列 (タグなし)。CLI エージェントの基本形: ツール実行ループ、権限3段階モデル、セットアップウィザード、セッション保存。
