# Changelog

このファイルはリリースごとの主要な変更を記録する。形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠する。公開版は `package.json` を単一ソースとする3桁SemVer、build identityはGit commitとして分離する。リリース前に `npm run validate:version -- --tag v<version>` を通す (docs/production-readiness.md PR-12)。

## [Unreleased]

### LLM API境界pause・機能比較 cycle 17 (2026-09-02)

- `/run pause|resume|status`を追加し、foreground runを進行中のmain LLM API完了直後に協調停止して、ローカルLLMの再起動・並列数変更後に同じrunを継続可能にした
- 主応答だけでなくcontext整理・意図判定・main evaluator fallbackを含む全main provider chat経路へ共通gateを適用し、pause中の新規API・tool実行を抑止
- 処理中type-aheadの`/run`だけを即時制御し、保存session復元の既存`/resume`・`/continue`とは名前空間を分離
- pause到達、API実行数、対象外のbackground task / second LLMを明示し、Esc/Ctrl+Cによるhard interruptもpause中に維持
- pauseはアプリを起動したままlocal LLMサーバーを再起動するプロセス内機能であり、PC再起動を跨ぐdurable run復元は次cycleの設計候補として分離

### リリース・バージョン整合 cycle 14 (2026-09-01)

- 公開版を3桁SemVer、実体識別をcommit由来buildとして分離し、tracked変更を含むbuildへ`-dirty`を付け、`package.json`を単一ソース化
- `validate:version`でmanifest/lock/CHANGELOG/release tagの不一致をCI検出
- `--check-update [--json]`を追加し、通信不能・不正tag・release asset欠落を理由と復旧手順付きで明示診断
- 公開`v0.4.1`に対して実体が`0.4.0`、CHANGELOG項目なし、asset 0件だった履歴不整合を記録し、公開履歴を改変せず現行版を整合

### 操作学習・機能比較 cycle 12 (2026-08-31)

- Codex Record & Replay / Claude skills / lllmAgentsの機能比較から、browser/computer操作を実演から再利用workflowへ変換できない`GAP-WL-01`を実装
- `/learn start|status|finish|cancel`と`workflow_learn_*`を追加し、成功した直列tool callをproject-local skillへatomic保存
- 入力文字列、URL query/fragment、screenshot path、一時window ID、tool出力を保存せずplaceholder化し、既存skill・symlink経由のproject外pathを拒否
- 失敗・並列操作を含む記録は黙って省略せずskill化を拒否し、生成skillを`disable-model-invocation: true`の手動起動専用に制限
- 実Playwright smokeでDOM入力・click・結果観測・秘密値非永続化を検証する`test:workflow-learning:browser`を追加

### Sub-agent worktree分離 cycle 11 (2026-08-31)

- Codex / Claude Codeとの機能比較と既存類似機能監査から、並列editing agentが同じcheckoutを共有する`GAP-02`をP1として実装
- `task.isolation: worktree`とcustom agent frontmatterを追加し、agent別detached checkout、変更なし自動除去、変更・取消・異常終了の保持に対応
- `task_diff` / `task_apply` / `task_discard`と`/tasks`を追加し、cleanかつ同一baseのmainへの明示回収と確認付き破棄を提供
- file/path toolのworkspace root、realpath containment、Git redirect、未知plugin/MCP toolをfail-closedにし、Native Windowsのworktree bashはWSL2案内付きで実行前拒否
- Git executable解決をdiff/checkpoint/worktreeで共通化し、checkpoint明示ON時のGit不在を警告継続せず起動前エラーに変更
- repository hook/filter、base drift、binary/untracked apply、並列同名編集、cancel/crash/restart recoveryを実Git回帰で固定

### Native Computer Use比較・改善 cycle 10 (2026-08-30)

- Codex / Claude / lllmAgentsのComputer Use機能比較マトリックスを追加し、`GAP-CU-01`を実装
- 明示opt-inの`computer_windows` / `computer_screenshot` / `computer_click` / `computer_type` / `computer_key` / `computer_scroll`を追加
- 選択window IDの再検証、window限定capture、local CLI限定、呼出しごとの一回許可を強制し、remote・autorun・永続許可による回避を拒否
- OS dependency不足とWaylandをbrowserへ暗黙代替せずfail-fastし、副作用なしの`--check-computer-use`を追加
- Windows専用可視window smokeで日本語入力、key/chord、click、scroll、対象windowのbefore/after captureを実動作検証
- runtime auditをlockfile限定にし、macOSのoptional dependency実体treeだけがnpm旧endpointで400になるCI差を解消

### 機能比較・差分レビュー cycle 9 (2026-08-30)

- `/diff`を統計表示から、stage済み・未stage・未追跡を含む実差分表示へ拡張
- PATHにGitがないWindowsでもGit for Windowsの標準install先を検証して利用し、Git不在・非repository・出力上限超過を復旧案内付きで表示
- `/rename <name>`を追加し、現在sessionの人が識別できる名前をatomic保存して`/resume list`とpickerへ反映
- skill validatorをruntimeの`trigger`/`context`/`tools`契約へ揃え、builtin/project skill全件を`--root`で検証
- npm packageをruntime allowlistへ限定し、SEA・test・sandbox等の混入と32 MiB超過をCIで拒否
- Codex / Claude Code / lllmAgentsの機能比較マトリックスcycle 9を追加

### TUI完成度レビュー cycle 7 (2026-08-27)

- Alternate ScreenのPgUp/PgDnを入力待ち中だけでなくLLM・ツール実行中も有効にし、最古行まで遡れるよう修正
- `--no-alt-screen`を追加し、端末本来のscrollback・選択・コピーへ明示的に切り替え可能にした
- TTYの端末能力不明やraw mode取得失敗で簡易表示へ黙って落とさず、原因と明示的な対処を表示してfail-fastする方針へ変更
- Linux/macOS実PTY smokeを履歴生成・PageUp・描画変化・PageDownまで検証するscenarioへ拡張
- Codex Desktop / Claude Desktopとの機能比較で、ブラウザ操作とは別のOS desktop Computer Use欠落をP2として記録

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

## [0.4.1] - 2026-08-13

公開tag/releaseは存在したが、tag先の`package.json`と`src/version.ts`が`0.4.0`のまま、CHANGELOG項目と配布assetも無かった。履歴は書き換えず、2026-09-01にmanifest/表示を`0.4.1`へ整合し、以後のCI検査を追加した。

- Qwen 3.6モデル対応

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
