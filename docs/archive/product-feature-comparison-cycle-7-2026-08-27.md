# Codex / Claude Code 機能比較・TUI完成度レビュー cycle 7

- 日付: 2026-08-27
- 基準commit: `0212504`
- 観点: Codex / Claude Code開発者の観点から見た機能充足、TUIの実用完成度、安全性、正しさ、運用性、配布可能性
- 対象: `3f6f509` / `066b2be` で導入した端末所有権・Alternate Screen TUI、現行CLI機能、直近の比較サイクルと実装
- 完了条件: 一次資料に基づく比較表を更新し、再現したTUIのP1を修正する。欠けていた通常scrollbackへのCLI escape hatchを追加し、unit・実PTY・E2E・lint/typecheck・coverage・build・配布smoke・最新push SHAのCIを通す。未解決P0/P1を残さない

## 1. 比較基準と証拠

外部仕様は2026-08-27に次の一次資料を確認した。

- OpenAI: [Codex CLI](https://developers.openai.com/codex/cli/)、[Developer commands](https://developers.openai.com/codex/cli/slash-commands)、[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- Anthropic: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)、[Let Claude use your computer in Cowork](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
- 本アプリ: `README.md`、`docs/tui-alternate-screen.md`、実装・テスト、`3f6f509` / `066b2be` 以降の履歴、2026-08-26以降の運用ログ集計

OpenAI公式資料ではCodex CLIにAlternate Screenを無効化する`--no-alt-screen`、TUI内の長い出力を扱うscrollback、session resume/fork、image/web context、subagents等がある。またCodex Desktopにはin-app browserとは別にComputer Useがあり、スクリーンショットを扱う。Claude Code公式資料ではsession resume、background agents、browser integration、safe mode、screen-reader向けclassic renderer等があり、Claude Desktop上のClaude Code/Coworkにはアプリ単位の許可を伴うComputer Useがある。

記号は `◎`=同等の中核機能あり、`○`=一部あり、`—`=同等機能なし。単にAPIやメソッドが存在するだけでは `◎` とせず、ユーザーが主要な状態で操作でき、回帰ゲートがその振る舞いを検出できるかまで評価する。

## 2. 機能比較マトリックス

| 機能領域 | Codex | Claude Code | lllmAgents（変更前） | 今回後 | 判定 |
|---|---|---|---|---|---|
| repository指示・memory | `AGENTS.md`、memories | `CLAUDE.md`、rules、auto-memory | `CLAUDE.md`、rules、`/memory` | 同左 | ◎ |
| skills / agents / plugin | skills、subagents、plugins | skills、subagents、plugins | skills、agents、local plugin bundle | 同左 | ○（marketplaceなし） |
| parallel / background / steer | subagents、background、follow-up | background sessions、agents、follow-up | task list/output/send/cancel | 同左 | ◎ |
| plan / goal / schedule | plan、goals、scheduled tasks | plan、tasks、`/loop` | `/plan`、Goal Seek、goal-loop、schedule | 同左 | ◎ |
| session resume / fork | resume、fork、archive | resume、fork-session、checkpointing | resume、checkpoint | 同左 | ○（session forkなし） |
| permission / sandbox / safe mode | approvals、OS sandbox、profiles | permission modes、safe mode | rules、autorun、Seatbelt/bwrap/WSL、safe mode | 同左 | ◎ |
| web search | live/cached web search | web search | search/fetch | 同左 | ◎ |
| browser操作 | browser / computer surfaces | Chrome integration | Playwright browser tools | 同左 | ○ |
| **OSデスクトップcomputer use** | Codex Desktopで画面認識・入力操作 | Claude Desktop上のClaude Code/Coworkで画面認識・入力操作 | **なし** | なし | **— (GAP-CU-01)** |
| image input / generation | image context / generation | image context | vision / image generation | 同左 | ◎ |
| TUI scrollback | TUI内scroll、raw scrollback、`--no-alt-screen` | fullscreen/classic・accessibility切替 | PgUp/PgDn APIはあるが入力待ち中だけ。最古行へ届かない | session全期間のPgUp/PgDn、最古行、CLI escape | ◎ |
| accessibility / classic mode | `--no-alt-screen`、raw mode | `--ax-screen-reader`、classic renderer | 環境変数のみ | `--no-alt-screen`を追加 | ○ |
| cost / multi-provider | usage、OpenAI models | usage、Claude providers | 複数provider、model slots、`/cost` | 同左 | ◎（独自強み） |

## 3. 発見事項と終端方針

| ID | 優先度 | 証拠・影響 | 終端方針 |
|---|:---:|---|---|
| TUI-SCROLL-01 | P1 | `interactive-input.ts`だけがPgUp/PgDnを処理する。エージェント実行中は入力listenerがなく、Alternate Screenにより端末本来のscrollbackも使えない | **今回修正**。ScreenManagerがsession全期間stdinのscroll sequenceを観測し、排他prompt以外で処理する。実PTY回帰を追加 |
| TUI-SCROLL-02 | P1 | 遡り中は案内に1行予約するが`scrollUp()`の最大offsetは予約前のviewportで計算するため、最古行が1行見えない | **今回修正**。遡り時content heightと同じ式で上限を計算し、最古行を回帰化 |
| TUI-ESCAPE-01 | P2 | 通常scrollbackへ戻す方法が`LLLMAGENT_DISABLE_ALTERNATE_SCREEN`だけで、Codex相当の明示CLI flagがない | **今回実装**。`--no-alt-screen`とREADME/helpを追加 |
| TUI-TEST-01 | P1 | 実PTY smokeは起動→`/quit`だけで、履歴生成・実行中scroll・描画変化を検証しないため上記退行をgreenにしていた | **今回修正**。PTY driverをscroll scenarioまで拡張し、unitは入力byteの分割も検証 |
| TUI-FALLBACK-01 | P1 | `TERM=dumb`、TERM未設定、端末能力不明、raw mode取得失敗を黙って簡易表示へ落とすと元の問題が見えず、機能が使えないまま起動成功に見える | **今回修正**。明示classic modeと非TTY以外は、原因と対処を示してfail-fastする。基本方針を`AGENTS.md`へ永続化 |
| GAP-CU-01 | P2 | `browser_*`はChromium内だけで、OS window列挙・対象拘束・capture・input injectionを持たない。Codex DesktopとClaude Desktopはいずれもbrowser機能とは別にComputer Useを提供する | **本cycleのTUI境界外**。現行sandboxはdesktop全体の読み取り/入力を封じ込められず、autorun・Discord/Slack permission、秘密画面、対象window拘束、cross-OS native driver、SEA配布の設計が先に必要。MCPで名前だけ露出する実装は機能充足と判定しない |
| GAP-FORK-01 | P2 | sessionを元履歴を保って分岐する機能がない | 既存checkpoint/Roomと重複しないsession identity設計が必要な独立境界。今回のTUI品質ゲートは阻害しない |

## 4. 改善設計

1. ScreenManagerがraw stdinの所有者である既存設計を維持し、同じ`data`購読でPageUp (`CSI 5 ~`) / PageDown (`CSI 6 ~`)をsession開始から終了まで観測する。sequenceが複数chunkへ分割されても末尾bufferで復元する。
2. ソフト所有（通常入力・progress）中と所有者なし（LLM/tool実行中）はscroll可能、inquirer等の排他所有中はpromptのキー意味を優先してscrollしない。
3. `InteractiveInput`側のPgUp/PgDn処理を削除して二重scrollを防ぎ、端末所有権とキー所有権をScreenManagerへ揃える。
4. scroll上限は、遡り中に案内行を除いた`max(1, viewportHeight - 1)`を基準にする。ただし全履歴が通常viewportへ収まる場合はscroll状態へ入らない。
5. `--no-alt-screen`をユーザーが意図して選ぶclassic stream modeとして加える。非TTYは独立した出力modeとし、TTYの能力不足・不明やraw mode取得失敗は黙って別動作へ落とさずfail-fastする。
6. welcomeと`/help`へPgUp/PgDnと明示的なclassic modeを表示し、実装を知らなければ使えない状態を解消する。

## 5. 変更前ベースライン

- `npm.cmd run lint`: exit 0、既存warning 281件・info 103件
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: sandbox内はesbuildの上位directory走査がaccess denied。制限外実行ではunit 101 files passed / 3 skipped、1162 tests passed / 24 skipped、E2E 4/4 passed
- `npm.cmd run analyze:loop -- --since 2026-08-26`: session 1、user span 1、stuck-loop 0。prompt・応答原文は取得・転載していない
- 作業開始時のユーザー所有変更: `sandbox/`配下の未追跡6群。変更・stage対象外

## 6. 実装・評価結果

### 実装

- `ScreenManager`のsession全期間stdin listenerへPageUp/PageDownのCSI処理を集約した。通常入力・progress・所有者なしのLLM/tool実行中で有効、排他prompt中は無効とした
- CSIが複数data chunkへ分割された場合も復元し、前chunkのsequenceを二重処理しない末尾bufferを追加した
- 案内行を除くcontent heightで最大offsetを計算し、最古行が必ず表示対象になるよう修正した
- `--no-alt-screen`、welcome・`/help`・READMEの操作案内を追加した
- 端末能力不明とraw mode取得失敗のsilent fallbackを廃止し、理由と`--no-alt-screen`を示すfail-fastへ変更した。方針は`AGENTS.md`のProduct failure policyへ固定した
- Linux/macOSの実PTY smokeを、起動終了だけでなく`/help`→PgUp→scroll案内の描画確認→PgDn→`/quit`へ拡張した

### 評価

- TDD: 変更前コードで「入力所有者がいないLLM/tool実行中のPgUp」回帰testが `scrollOffset() === 0` で失敗することを確認。変更後はscreen-manager 75/75、関連3 files 78/78 passed
- Windows ConPTY実測: 30行を描画した実行中sessionへPageUpを送り、末尾`ROW-24..30`から`ROW-18..24`とscroll案内へ変化することを確認。PageDownで末尾へ戻り、`WINDOWS-CONPTY-SCROLL-PASS`
- `npm.cmd run test:coverage`: 101 files passed / 3 skipped、1172 tests passed / 24 skipped。Statements 37.96%、Branches 76.64%、Functions 61.82%、Lines 37.96%
- `npm.cmd run test:e2e`: 4/4 passed
- `npm.cmd run lint`: exit 0、既存warning 281件・info 103件（変更前と同数）
- `npm.cmd run build`、`npm.cmd run validate:skills`: passed
- `npm.cmd audit --omit=dev --audit-level=high`: 0 vulnerabilities
- `npm.cmd run build:exe`と生成した`dist/localllm.exe --version`: passed。`build:deploy`はユーザーが起動中の`deploy/localllm.exe` (PID 29368) を停止・上書きせず中断したため、同等の配布gateは最新push SHAのCI `package-smoke`で閉じる

### 終端判定

| ID | 結果 |
|---|---|
| TUI-SCROLL-01 | closed。session全期間入力とWindows ConPTYで確認 |
| TUI-SCROLL-02 | closed。最古行testで確認 |
| TUI-ESCAPE-01 | closed。`--no-alt-screen`と利用案内を追加 |
| TUI-TEST-01 | closed。Linux/macOS実PTY scenarioとdriver testを拡張 |
| TUI-FALLBACK-01 | closed。端末能力・raw modeの失敗理由を隠さない回帰testとrepository規約を追加 |
| GAP-CU-01 | open P2。ブラウザ操作とは別のnative desktop能力として、permission/sandboxを先に設計する |
| GAP-FORK-01 | open P2。session identity設計を伴う独立cycleへ送る |

未解決P0/P1はない。最新push SHAの全dependent CI jobを監視し、失敗時は本cycleを再開する。CI結果は実装後の記録専用commitを作らず、同SHAのhandoffへ記録する。
