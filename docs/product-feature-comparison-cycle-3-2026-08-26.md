# Codex / Claude Code 機能比較・商品品質改善サイクル 3

Status: completed

- 実施日: 2026-08-26
- 基準 commit: `7e75d576f3cb544199e85722f1341c72e1ad7e25`
- 観点: Codex / Claude Code に類するローカル開発エージェントとしての機能充足、正しさ、安全性、運用性、UX、配布可能性
- 対象: バックグラウンドsub-agentのライフサイクル、provider中断、tool registry、権限、関連テスト・設計・配布物
- 完了条件: 公式機能との比較表を更新し、バックグラウンド委任の一覧・停止を実装する。回帰・全unit・E2E・lint/typecheck・coverage・build・配布smoke・最新push SHAのCIを通し、未解決P0/P1を残さない

## 1. 比較基準と証拠

外部仕様は次の一次資料を2026-08-26に確認した。

- OpenAI Docs: [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Scheduled tasks](https://learn.chatgpt.com/docs/automations)
- Anthropic: [Run agents in parallel](https://code.claude.com/docs/en/agents)、[Agent teams](https://code.claude.com/docs/en/agent-teams)、[Worktrees](https://code.claude.com/docs/en/worktrees)、[Plugins](https://code.claude.com/docs/en/plugins)
- 本アプリ: `README.md`、`docs/README.md`、`docs/external_design.md`、`docs/internal_design.md`、実装・テスト・直近12 commit、2026-08-26以降の運用ログ集計

Codexはactive/doneの確認とrunning agentのstopを提供する。Claude Codeは`/tasks`で実行中・完了済み項目を一覧し、確認・attach・stopできる。本アプリは変更前、`task(run_in_background)`と結果を待つ`task_output`だけを提供する。

記号は `◎`=同等の中核機能あり、`○`=一部あり、`—`=同等機能なし。製品面が異なる機能は、欠落だけで直ちにバグとは判定しない。

## 2. 機能比較マトリックス

| 機能領域 | Codex | Claude Code | lllmAgents（変更前） | 判定 |
|---|---|---|---|---|
| リポジトリ指示・永続メモリ | `AGENTS.md`、Memories | `CLAUDE.md`、rules、auto-memory | `CLAUDE.md`、rules、`/memory` | ◎ |
| スキル・カスタムagent | skills / plugins、TOML agent | skills / plugins、agent frontmatter | skills、Markdown agent、model/max turns/preload skills | ◎ |
| 並列・バックグラウンド委任 | subagent threads | subagents / agent view | `task(run_in_background)` | ◎ |
| **バックグラウンドtask一覧・停止** | Active/Done、inspect、stop | `/tasks`でrunning/done、attach、stop | 結果待機の`task_output`のみ。一覧・停止なし | **— (GAP-06)** |
| 実行中agentへの追加指示 | follow-up / steer | agent teams / cross-session message | parentへの最終結果返却のみ | — (GAP-05) |
| worktree分離 | agent/worktree環境 | session / subagent worktree | shadow Git checkpointのみ | — (GAP-02) |
| MCP / hooks | MCP、command hooks | MCP、command/prompt/HTTP/agent hooks | MCP、command hooks | ○ |
| 権限・sandbox | profiles、approvals、OS sandbox | allow/ask/deny、permission modes | rules、autorun、Seatbelt/bwrap/WSL | ◎ |
| plan・長期ゴール | plan、long-running goals | plan、goals | `/plan`、Goal Seek、決定的check | ◎ |
| checkpoint / rewind | Record & Replay | `/rewind` | shadow Git `/checkpoint`、session resume | ○ |
| Web・browser・画像 | web/browser/computer/image | web/browser/image | web search/fetch、Playwright、vision/image generation | ◎ |
| session schedule | Scheduled tasks | `/loop`、Cron tools | `/loop`、`schedule_create/list/delete` | ◎ |
| remote / chat surface | Remote、Slack等 | remote control、channels | Discord/Slack Gateway、Room A/B/C | ○ |
| 配布可能なplugin bundle | skills/MCP/UI plugin | skills/agents/hooks/MCP/LSP/monitor plugin | 個別loaderのみ | — (GAP-04) |
| コスト・複数provider | usage、OpenAI models | usage、Claude providers | local/API複数provider、model slots、`/cost` | ◎（独自強み） |

## 3. 発見事項と終端方針

| ID | 優先度 | 証拠・影響 | 終端方針 |
|---|:---:|---|---|
| GAP-06 | P1 | background taskはIDを返すが、一覧も停止もできない。不要・暴走・長時間化した委任がtoken/costを消費し、tool実行を続けても利用者・親agentが介入できない | **今回実装**。`task_list`と`task_cancel`、状態追跡、LLM request中断を追加する |
| TASK-01 | P2 | `isRunning()`がPromiseのMap存在だけを見ているため、処理完了後も`task_output`で回収するまでrunningと誤表示する | **今回修正**。`running/completed/failed/cancelled`を明示状態として追跡し、回帰テストを追加する |
| GAP-02 | P2 | parallel agentが同じworktreeを共有し、競合編集を隔離しない | **今回範囲外**。branch所有・成果取込・未コミット変更・Windows Gitを一体設計する独立境界。今回のtask lifecycleゲートを妨げない |
| GAP-05 | P2 | 実行中agentへのfollow-up、peer messaging、共有task listがない | **今回範囲外**。会話追記にはprovider別のturn再開、mailbox、token budget設計が必要。停止とは独立した次の機能境界 |
| GAP-04 | P3 | skills/agents/hooks/MCPの統合manifest/marketplaceがない | **今回範囲外**。個別拡張は利用可能で、署名・信頼・更新・競合解決を含む配布製品の別境界 |

レビュー時点でGAP-06以外のP0/P1は発見していない。GAP-06は同じサイクルで閉じる。

## 4. GAP-06 / TASK-01 改善設計

1. `SubAgentManager`はbackground taskごとにagent、Promise、開始・完了時刻、`running/completed/failed/cancelled`、結果を保持する。完了PromiseをMapに置くだけの状態判定を廃止する。
2. `task_list`はpromptや結果本文を転載せず、ID、agent type、短いdescription、状態、開始・完了時刻だけを返す。作成順を維持する。
3. `task_cancel`はrunning taskだけをID指定で停止する。不存在と完了済みを区別し、二重cancelを成功扱いにしない。
4. `SubAgent`は各LLM呼出しへ`AbortSignal`を渡し、中断時は新しいtool呼出し・次iterationを開始しない。進行中tool自体は強制終了せず、戻った直後に停止する。
5. cancel直後から状態と結果を`cancelled`として取得可能にする。遅れて解決したprovider応答でcompleted/failedへ上書きしない。
6. OpenAI-compatible / Geminiに加え、HTTP型Azure GPT / AnthropicとClaude CLI / Agent SDKにもsignalを伝播し、可能な限りサーバ生成・子processを止める。
7. task lifecycle管理はmain orchestrator専権とし、sub/second contextから`task_list` / `task_cancel`を除外する。両toolはsession内管理操作としてauto許可する。
8. 回帰テストは完了状態遷移、一覧の本文非露出、cancelのsignal伝播・即時結果、二重cancel、unknown/finished、子context除外、tool配線を確認する。

## 5. 変更前ベースライン

- `npm.cmd run lint`: exit 0、既存warning 282件・info 103件
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: sandbox内ではesbuildの上位ディレクトリ走査がaccess denied。制限外実行ではunit 95 files passed / 3 skipped、1121 tests passed / 24 skipped、E2E 3/3 passed
- `npm.cmd run analyze:loop -- --since 2026-08-26`: 対象となる本番session log 0件。prompt・応答原文は取得・転載していない
- 作業開始時のユーザー所有変更: `sandbox/`配下の未追跡6群。変更・stage対象外

## 6. 実装・評価結果

### 6.1 実装結果

- `task_list` / `task_cancel`をtool registry、権限既定値、main orchestrator contextへ追加した。一覧はprompt・result本文を含まないmetadataだけを返す。
- `SubAgentManager`を明示状態管理へ変更し、完了済みtaskをrunningとする誤判定を修正した。cancel後の遅いprovider応答は状態を上書きしない。
- 各sub-agent LLM requestへ`AbortSignal`を渡し、OpenAI-compatible / Geminiに加えてAzure GPT / Anthropic、Claude CLI、Claude Agent SDKへ中断を伝播した。進行中toolは戻りを待つが、後続toolと次iterationは開始しない。
- lifecycle管理toolはmain orchestrator専権とし、sub / second agent contextから除外した。
- 状態遷移、metadata非露出、signal伝播、二重・不正cancel、tool途中cancel、tool配線、子context除外を回帰テスト化した。

### 6.2 ローカル評価

| ゲート | 結果 |
|---|---|
| 対象回帰 | 5 files / 33 tests passed |
| lint | passed。既存warning 282件・info 103件でbaselineから増加なし |
| build / typecheck | passed |
| unit + coverage | 96 files passed / 3 skipped、1127 tests passed / 24 skipped。statements 36.91%、branches 76.13%、functions 60.16%、lines 36.91%。全threshold通過 |
| E2E | 3/3 passed |
| deploy build | SEA / CJS bundle / 19 skills / 5 agentsを生成 |
| 配布smoke | SEAとCJS bundleの`--version`がexit 0。bundle内に`task_list` / `task_cancel`を確認 |
| skill validation | product-quality-cycle / demo skillともpassed |
| dependency audit | `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities |
| diff hygiene | `git diff --check`: passed。作業開始時の`sandbox/`未追跡6群は変更・stage対象外 |

sandbox内の`test:all` / deploy buildは、esbuildがworkspace外の上位directoryを走査する際にaccess deniedとなるため、同一commandを制限外で再実行して成功を確認した。これは製品失敗ではなく実行環境制約として終端した。また、tool途中cancelの初回test fixtureは一般purpose agentのtool allowlist外の仮名を使ってtimeoutしたため、実在の許可tool名へ修正し、対象回帰と全unitで安定通過させた。

### 6.3 発見事項の終端状態

| ID | 終端状態 |
|---|---|
| GAP-06 | **resolved locally**。一覧・停止・provider中断・回帰テストを実装し、全ローカルゲート通過 |
| TASK-01 | **resolved locally**。明示状態管理へ変更し、完了済みの`isRunning=false`を回帰確認 |
| GAP-02 | accepted / P2。独立したworktree隔離サイクルへ送る |
| GAP-05 | accepted / P2。provider横断の会話再開・mailbox設計サイクルへ送る |
| GAP-04 | accepted / P3。配布・信頼モデルを含むplugin productサイクルへ送る |

未解決P0/P1はない。最終完了判定は、この変更をpushした最新SHAに対するUbuntu / macOS / Windows testとWindows package-smokeの全依存job成功とする。

## 7. CI closure

- 実装commit / push: `29c405772d838741f5f04c9192ee3ce98879c819` (`main` / `origin/main`)
- GitHub Actions: [CI run 133](https://github.com/t2k2pp/lllmAgents/actions/runs/32907899671) — success
- `test (ubuntu-latest)`: success
- `test (macos-latest)`: success
- `test (windows-latest)`: success
- 依存job `Windows deploy / exe smoke`: success

このclosure記録commitも新しいcompletion candidateとしてpushし、同じ全依存jobの成功を最終handoffで確認する。
