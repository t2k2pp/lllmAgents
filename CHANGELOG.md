# Changelog

このファイルはリリースごとの主要な変更を記録する。形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、バージョンは semver。リリース時は `package.json` / `src/version.ts` のバージョンを揃え、`v<version>` タグを打つ (docs/production-readiness.md PR-12)。

## [Unreleased]

### 製品品質 (docs/production-readiness.md P3+P4)

- ログ・セッションの世代管理: 起動時に古い ops/LLM I/O ログ (既定30日) とセッション (既定100件超過分) を告知つきで削除。`logging.retention` で調整可能 (PR-15)
- シークレット分離: API キー・Bot/App トークン・Webhook URL を `~/.localllm/credentials.json` (自ユーザーのみ) へ分離。旧 config.json からは初回起動時に自動移行 (PR-04 方針2)
- カバレッジ可視化: `npm run test:coverage` と CI レポート出力 (閾値ゲートなし) (PR-09)
- REPL コマンドレジストリ: `src/cli/commands/` に1コマンド=1ファイル方式を新設。補完・/help を自動生成し、`/parallel` `/autorun` `/loglevel` を移設 (PR-10 漸進移行の基盤)
- `/doctor` 環境診断コマンド: LLM接続 / Playwright / Discord / Slack / 画像生成 / ディスク使用量を読み取り専用で一括チェック (PR-16)
- 更新通知: 起動時に GitHub の最新リリースを確認し、新しければ1行通知 (TTY のみ、`updateCheck.enabled: false` でオフ) (PR-14)

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
