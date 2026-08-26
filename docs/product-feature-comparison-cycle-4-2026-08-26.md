# Codex / Claude Code 機能比較・商品品質改善サイクル 4

Status: locally validated; CI pending

- 実施日: 2026-08-26
- 基準 commit: `b96c0885173da0634ce827627adcad714324dcd3`
- 観点: Codex / Claude Code に類するローカル開発エージェントとしての機能充足、正しさ、安全性、運用性、UX、配布可能性
- 対象: 実行中background sub-agentへの追加指示、task lifecycle、tool registry、権限、関連テスト・設計・配布物
- 完了条件: 公式機能との比較表を更新し、実行中taskへの順序保証付き追加指示を実装する。回帰・全unit・E2E・lint/typecheck・coverage・build・配布smoke・最新push SHAのCIを通し、未解決P0/P1を残さない

## 1. 比較基準と証拠

外部仕様は次の一次資料を2026-08-26に確認した。

- OpenAI Docs: [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- Anthropic: [Create custom subagents](https://code.claude.com/docs/en/sub-agents)、[Agent teams](https://code.claude.com/docs/en/agent-teams)、[Run agents in parallel](https://code.claude.com/docs/en/agents)
- 本アプリ: `README.md`、`docs/README.md`、`docs/external_design.md`、`docs/internal_design.md`、実装・テスト・直近15 commit、2026-08-26以降の運用ログ集計

OpenAI Docsは、orchestratorがsub-agentへのfollow-up指示をroutingし、実行中agentをsteerできると説明する。Claude Codeはnamed subagentへのfollow-up、agent teamの直接message、実行中forkのsteerを提供する。本アプリは変更前、taskの起動・一覧・停止・結果回収まではできるが、実行中taskへ追加指示を送れない。

記号は `◎`=同等の中核機能あり、`○`=一部あり、`—`=同等機能なし。製品面が異なる機能は、欠落だけで直ちにバグとは判定しない。

## 2. 機能比較マトリックス

| 機能領域 | Codex | Claude Code | lllmAgents（変更前） | 判定 |
|---|---|---|---|---|
| リポジトリ指示・永続メモリ | `AGENTS.md`、Memories | `CLAUDE.md`、rules、auto-memory | `CLAUDE.md`、rules、`/memory` | ◎ |
| スキル・カスタムagent | skills / plugins、TOML agent | skills / plugins、agent frontmatter | skills、Markdown agent、model/max turns/preload skills | ◎ |
| 並列・background委任 | subagent threads | subagents / agent view / agent teams | `task(run_in_background)` | ◎ |
| background task一覧・停止 | Active/Done、inspect、stop | `/tasks` / agent panelでinspect、stop | `task_list`、`task_cancel`、`task_output` | ◎ |
| **実行中agentへの追加指示** | follow-up routing、steer | named subagent follow-up、fork steer、team message | 取消して新規taskを起動する以外に手段なし | **— (GAP-05)** |
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
| GAP-05 | P1 | 実行中taskの前提が変わっても追加指示できず、取消・再起動で調査結果、tool進捗、tokenを失う。古い方針のtool実行を止めて方向転換する手段がない | **今回実装**。`task_send`、順序付きmailbox、LLM中断、古い未実行toolのskipを追加する |
| STEER-01 | P1 | 単純にhistoryへmessageを追加するだけでは、進行中LLMが返した古いtool callを追加指示後に実行しうる | **今回予防修正**。LLM待機中はabortして新しいturnへ移り、tool実行中はその1件の完了後に残りのtool callをskipしてmessageを適用する |
| TASK-02 | P1 | 最大turn到達で最終回答が無い場合も`success: true`となり、background taskが`completed`と誤表示されることを境界テストで再現 | **今回修正**。最大turn到達結果をfailureとして状態化し、回帰テストで`failed`を確認する |
| GAP-02 | P2 | parallel agentが同じworktreeを共有し、競合編集を隔離しない | **今回範囲外**。branch所有・成果取込・未コミット変更・Windows Gitを含む独立境界。今回のmessage routingゲートを妨げない |
| GAP-04 | P3 | skills/agents/hooks/MCPの統合manifest/marketplaceがない | **今回範囲外**。署名・信頼・更新・競合解決を含む配布製品の別境界 |

## 4. GAP-05 / STEER-01 改善設計

1. `task_send(agent_id, message)`を追加し、running background taskだけへ追加指示を送る。不存在・回収済み、終了済み、空文字、4000文字超、queue満杯、turn上限を個別に診断する。
2. `SubAgent`は最大20件のFIFO mailboxを保持する。指示は親agent由来と分かる境界タグを付け、既存conversation historyへuser-roleの新turnとして追加する。
3. LLM生成中に指示が届いた場合はそのrequestの`AbortSignal`を発火し、部分応答や古いtool callを採用せず次turnへ進む。providerがsignalを無視して応答した場合も、tool call実行前にmailboxを検知してskipする。
4. tool実行中の強制停止はしない。現在のtool結果を履歴へ追加した後、同じassistant turnに残る未実行tool callへskip結果を補ってtool pairingを保ち、次turnで追加指示を処理する。
5. 複数指示は受付順を保って1回の次turnへまとめる。指示1件につき必要ならLLM turn予算を1つ増やすが、総呼出回数は30を超えない。
6. `task_list`には本文を返さず、受理済み追加指示の累計件数だけをmetadataとして返す。`task_send`の応答にも本文をechoしない。
7. `task_send`はsession内管理操作としてauto許可する。main orchestrator専権とし、sub / second contextからは`task_list` / `task_cancel`と同様に除外する。
8. 回帰テストはLLM待機中のabortと再steer、複数指示のFIFO、tool途中の後続skip、本文非露出、入力・queue・turn境界、unknown/finished/cancelled、tool配線、子context除外を確認する。

## 5. 変更前ベースライン

- `npm.cmd run lint`: exit 0、既存warning 282件・info 103件
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: sandbox内ではesbuildの上位directory走査がaccess denied。制限外実行ではunit 96 files passed / 3 skipped、1127 tests passed / 24 skipped、E2E 3/3 passed
- `npm.cmd run analyze:loop -- --since 2026-08-26`: 対象となる本番session log 0件。prompt・応答原文は取得・転載していない
- `npm.cmd audit --omit=dev --audit-level=high`: 0 vulnerabilities
- 作業開始時のユーザー所有変更: `sandbox/`配下の未追跡6群。変更・stage対象外

## 6. 実装・評価結果

### 実装

- `task_send`をtool registryへ追加し、main orchestratorからrunning background taskへ追加指示を送信可能にした。
- `SubAgent`へFIFO mailbox、LLM生成中のabort、signalを無視するprovider向けの古いtool call抑止、tool実行中の後続call skipを実装した。
- 追加指示は最大4000文字、pending 20件、LLM呼出し総数30回までに制限した。`task_list` / `task_send`は本文を返さず累計件数だけを公開する。
- `task_send`をmain-onlyかつsession内の安全な管理操作として権限・delegation context・default configへ統合した。
- 最大turn到達時に最終回答がないtaskを`completed`ではなく`failed`とする既存境界不具合を修正した。
- README、変更履歴、外部・内部設計を実装と同期した。

### TDD・回帰評価

- 先に追加した回帰テストは、実装前に`sendBackground` / `task_send`未実装として4件失敗することを確認した。
- 対象回帰: 4 files、53 tests passed。FIFO、LLM abort、signal無視、tool途中の後続skip、本文非露出、入力・queue・turn上限、終了状態、tool配線、子context除外を検証した。
- 全unit + coverage: 96 files passed / 3 skipped、1132 tests passed / 24 skipped。coverageはstatements 37.09%、branches 76.41%、functions 60.31%、lines 37.09%。
- E2E: 3/3 passed。
- lint: exit 0、変更前と同じwarning 282件・info 103件。新規errorなし。
- `npm.cmd run build`: passed。
- `npm.cmd run build:deploy`: Windows SEA / CJSともpassed。CJS bundle内の`task_send`、同梱agent、`product-quality-cycle` skillをsmoke確認し、両配布CLIの`--version`がexit 0となることを確認した。
- `npm.cmd run validate:skills`: `product-quality-cycle` / `demo`ともpassed。
- `npm.cmd audit --omit=dev --audit-level=high`: 0 vulnerabilities。
- live API credentialを用いた外部provider接続は実行していない。providerがabortを尊重する場合・無視する場合の双方を決定的mockで検証した。

### Finding終端

- GAP-05、STEER-01、TASK-02: 実装・回帰・全ローカルgateで解消。
- GAP-02、GAP-04: 比較表に残すP2/P3の製品ロードマップ項目。今回のP0/P1残件はない。
- ユーザー所有の`sandbox/`未追跡ファイルは変更・stageしていない。

## 7. CI closure

本記録を含む実装commitを`main`へpushし、最新SHAの全依存job完了後にcommit / workflow URL / job結果を追記する。
