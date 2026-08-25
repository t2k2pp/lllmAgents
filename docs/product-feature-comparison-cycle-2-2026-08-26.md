# Codex / Claude Code 機能比較・商品品質改善サイクル 2

Status: local-validated (latest pushed SHA CI pending)

- 実施日: 2026-08-26
- 基準 commit: `0d7fb13cc4950b1438cc9b18121d83ae8bd2d833`
- 観点: Codex / Claude Code に類するローカル開発エージェントとしての機能充足、正しさ、安全性、運用性、UX、配布可能性
- 対象: 定時プロンプト、`src/loop`、REPL、tool registry、権限、関連テスト・設計・配布物
- 完了条件: 公式機能との比較表を更新し、類似性と利用価値が高い欠落を1件以上実装する。回帰・全unit・E2E・lint/typecheck・coverage・build・配布smoke・最新push SHAのCIを通し、未解決P0/P1を残さない

## 1. 比較基準と証拠

外部仕様は次の一次資料を2026-08-26に確認した。

- OpenAI: [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Scheduled tasks](https://learn.chatgpt.com/docs/automations)
- Anthropic: [Run agents in parallel](https://code.claude.com/docs/en/agents)、[Agent teams](https://code.claude.com/docs/en/agent-teams)、[Worktrees](https://code.claude.com/docs/en/worktrees)、[Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)、[Plugins](https://code.claude.com/docs/en/plugins)
- 本アプリ: `README.md`、`docs/README.md`、`docs/external_design.md`、`docs/loop_feature.md`、実装・テスト・直近15 commit

記号は `◎`=同等の中核機能あり、`○`=一部あり、`—`=同等機能なし。製品面が異なる機能は、欠落だけで直ちにバグとは判定しない。

## 2. 機能比較マトリックス

| 機能領域 | Codex | Claude Code | lllmAgents（変更前） | 判定 |
|---|---|---|---|---|
| リポジトリ指示・永続メモリ | `AGENTS.md`、Memories | `CLAUDE.md`、rules、auto-memory | `CLAUDE.md`、rules、`/memory` | ◎ |
| スキルの発見・明示実行 | Skills / plugins | Skills / plugins | 組み込み・user・project skills、`skill` tool | ◎ |
| カスタムサブエージェント | TOML agent config、model/effort/sandbox/MCP | agent frontmatter、model/tools/hooks/memory | Markdown定義、model slot、tool allowlist、max turns、skill preload | ◎ |
| 並列・バックグラウンド委任 | subagent thread、steer/stop/close | subagents / agent view / agent teams | `task(run_in_background)`、`task_output`、並列上限 | ○ |
| agent間協調 | parent orchestration、follow-up/stop | shared task、mailbox、peer message | parent集約。peer messagingなし | ○ (GAP-05) |
| worktree分離 | 独立chat・scheduled taskのworktree | session / subagent worktree | shadow Git checkpointのみ。並列編集の分離なし | — (GAP-02) |
| MCP / hooks | MCP、hooks | MCP、command/prompt/HTTP/agent hooks | MCP client/manager、command hooks | ○ |
| 権限・sandbox | profiles、approvals、OS sandbox | allow/ask/deny、permission modes | rules、autorun、Seatbelt/bwrap/WSL、channel bridge | ◎ |
| plan・長期ゴール | plan、long-running goals | plan、goals | `/plan`、Goal Seek、決定的check | ◎ |
| checkpoint / rewind | Record & Replay | `/rewind` | shadow Git `/checkpoint`、session resume | ○ |
| Web・browser・画像 | web/browser/computer/image | web/browser/image | web search/fetch、Playwright、vision/image generation | ◎ |
| ユーザー向け定時プロンプト | Scheduled tasks、event trigger、worktree | `/loop`、session Cron | `/loop`のprocess内反復 | ○ |
| **モデル向けschedule管理** | Chatからtaskを作成・管理 | `CronCreate` / `CronList` / `CronDelete` | `/loop`はREPL switch直結で、モデルが作成・一覧・取消できない | **— (GAP-03)** |
| remote / chat surface | Remote、Slack等 | remote control、channels | Discord/Slack Gateway、Room A/B/C | ○ |
| 配布可能なplugin bundle | skills/MCP/UI plugin | skills/agents/hooks/MCP/LSP/monitor plugin | 個別loaderはあるが統合bundle/marketplaceなし | — (GAP-04) |
| コスト・複数provider | usage表示、OpenAI models | usage表示、Claude providers | local/API複数provider、main/second/model slots、`/cost` | ◎（独自強み） |

## 3. 発見事項と終端方針

| ID | 優先度 | 証拠・影響 | 終端方針 |
|---|:---:|---|---|
| GAP-03 | P2 | `LoopManager`はREPLの`/loop`からしか参照されず、tool registryにschedule操作がない。エージェントが「10分後にCIを再確認」のような依頼を自ら登録・確認・取消できない | **今回実装**。session-scopedな`create/list/delete` toolsを追加する。既存`/loop`と同じmanagerを共有し、最大件数・間隔・重複実行・例外を安全に扱う |
| TIMER-01 | P1 | `setInterval(async () => await runner())`がrejectを捕捉せず、実行時間が間隔を超えた場合の重複防止もない。schedule toolとしてモデルに公開すると未処理rejectや同時実行を増幅しうる | **今回修正**。manager内で例外を状態化し、同一entryの同時実行を禁止する。回帰テストを追加する |
| MREG-01 | P1 | 全体coverageで、UUID先頭8文字が数字だけのとき`resolveEntryQuery`が範囲外一覧番号として早期終了し、ID短縮指定できない不具合を再現 | **今回修正**。7桁以下の数字指定は一覧番号として扱い、8桁以上はUUID前方一致へ継続する。固定UUIDの決定的回帰を追加する |
| TEST-01 | P2 | coverageと反復テストの並列負荷時、画像縮小テストが1024pxランダムノイズ生成・再encodeで10秒を超えた。製品処理の失敗でなくfixture負荷によるflake | **今回修正**。同じ「上限の半分へ縮小」分岐を保つ512px fixtureへ縮小し、対象を反復して安定性を確認する |
| GAP-02 | P2 | parallel agentが同じworktreeを共有し、競合編集を隔離しない | **今回範囲外**。Git branch所有・成果取込・未コミット変更・Windows Gitを一体設計する必要があり、session scheduler境界と独立。既存機能は分割所有・read-only agent運用を明示している |
| GAP-05 | P2 | peer messaging・共有task listがない | **今回範囲外**。現在はparent集約を製品境界とし、今回のscheduler実装とは状態所有・UI・token budgetが独立 |
| GAP-04 | P3 | skills/agents/hooks/MCPを1単位で配布するmanifest/marketplaceがない | **今回範囲外**。個別拡張は利用可能で、署名・信頼・更新・競合解決を含む配布製品の別境界 |

レビュー時点で上記TIMER-01以外の再現可能なP0/P1不具合は発見していない。TIMER-01は新機能公開前に同じサイクルで閉じる。

## 4. GAP-03 / TIMER-01 改善設計

1. `schedule_create`、`schedule_list`、`schedule_delete`を追加する。vendor固有名を避け、既存`/loop`と同じsession-scoped managerを使う。
2. `schedule_create`は`prompt`、`delay`（`10s` / `5m` / `2h` / `1d`）、`recurring`を受ける。既定は安全なone-shot、10秒未満・7日超・空prompt・4000文字超を拒否する。
3. active scheduleは最大50件。list結果にはID、prompt、間隔、one-shot/recurring、次回時刻、実行・skip・失敗回数、最終errorを返し、Node timerや内部callbackは返さない。
4. 同じentryのrunnerは同時実行しない。REPLがbusyならrecurringはその回をskip、one-shotは1秒後に延期して消失を防ぐ。
5. runnerの例外はunhandled rejectionにせずentryの`failureCount` / `lastError`へ記録する。one-shotは失敗後に終了し、recurringは次周期に再試行できる。
6. schedule作成・一覧・取消はメモリ上のsession操作なのでauto扱いとする。将来実行されるprompt内の各toolは従来どおり個別のpermission / sandboxを通る。
7. schedule toolsはREPLのmain agentにだけ登録する。Discord/Slack headless面やsubagentから、別Roomのmain会話へ暗黙に将来promptを注入させない。
8. 回帰テストは入力境界、one-shot/recurring、最大50件、busy延期、重複防止、例外状態化、listの内部情報非露出、deleteを確認する。

## 5. 変更前ベースライン

- `npm.cmd run lint`: exit 0、既存warning 282件・info 103件
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: sandbox内ではesbuildの上位ディレクトリ走査がaccess denied。制限外実行ではunit 93 files passed / 3 skipped、1107 tests passed / 24 skipped、E2E 3/3 passed
- 作業開始時のユーザー所有変更: `sandbox/`配下の未追跡6群。変更・stage対象外

## 6. 実装・評価結果

### 6.1 実装

- main REPLのtool registryへ`createScheduleTools()`が返す`schedule_create`、`schedule_list`、`schedule_delete`を登録し、既存`/loop`と1個の`LoopManager`を共有した。
- `LoopManager`へone-shot、最大50件、次回実行時刻、busy時の延期／skip、同一entryの重複防止、runner例外の捕捉・状態化を追加した。
- schedule toolsはmain REPLだけに公開し、subagent / second-agent contextでは明示的に除外した。管理操作は安全なsession内操作としてauto許可し、実行prompt内のtool権限は既存経路を維持した。
- `resolveEntryQuery`の数字だけのUUID前方一致を修正した。画像縮小テストのランダムfixtureを512pxへ軽量化し、同じ縮小分岐を維持した。
- README、外部／内部設計、loop仕様、CHANGELOGを実装に同期した。

### 6.2 評価

| 品質ゲート | 結果 |
|---|---|
| schedule / loop / delegation / registry / image対象回帰 | 49/49 passed |
| registry + image不安定性反復 | 20回、合計740 tests passed |
| 全unit + coverage | 95 files passed / 3 skipped、1121 tests passed / 24 skipped。Statements 36.51%、Branches 75.97%、Functions 59.63%、Lines 36.51%で全threshold passed |
| E2E | 3/3 passed |
| lint / typecheck | exit 0。既存warning 282件・info 103件でベースラインから増加なし |
| build | `npm.cmd run build` passed |
| 配布検証 | `build:deploy`、`validate:skills` passed。Windows SEA / CJSとも`v0.4.0`起動、bundle内`schedule_create`確認、19 skills / 5 agents同梱 |

全体coverageによりMREG-01を、並列負荷試験によりTEST-01を追加発見し、いずれも同じサイクル内で再現・修正・決定的回帰化した。未解決のP0/P1はない。

## 7. 終了判定

- GAP-03: **implemented**
- TIMER-01 / MREG-01 / TEST-01: **fixed and regression-tested**
- GAP-02 / GAP-05 / GAP-04: **scope-out with product-boundary rationale**
- ローカル品質ゲート: **passed**
- 最新push SHAのCI: **pending**

したがって実装・ローカル評価は完了。最終終了判定は最新push SHAのCI完了後に確定する。
