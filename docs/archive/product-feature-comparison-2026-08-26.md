# Codex / Claude Code 機能比較・商品品質改善サイクル

Status: completed (latest pushed closure-record CI is the final handoff gate)

- 実施日: 2026-08-26
- 基準 commit: `aad4585f4cb59fc582d18d0603f6144553e86f43`
- 観点: Codex / Claude Code に類するローカル開発エージェントとしての機能充足、正しさ、安全性、運用性、UX、配布可能性
- 対象: `src/agents`、`src/agent/sub-agent.ts`、`task` ツール、関連テスト・設計・配布物
- 完了条件: 2026-08-26 時点の公式機能との比較表を残し、類似性と利用価値が高い欠落を1件以上実装し、回帰・全unit・E2E・lint/typecheck・coverage・build・配布smoke・最新push SHAのCIを通す。未解決P0/P1を残さない

## 1. 比較基準と証拠

外部仕様は次の一次資料を2026-08-26に確認した。

- OpenAI: [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Scheduled tasks](https://learn.chatgpt.com/docs/automations)
- Anthropic: [Run agents in parallel](https://code.claude.com/docs/en/agents)、[Create custom subagents](https://code.claude.com/docs/en/sub-agents)、[Extend Claude Code](https://code.claude.com/docs/en/features-overview)、[Run prompts on a schedule](https://code.claude.com/docs/en/scheduled-tasks)、[Configure permissions](https://code.claude.com/docs/en/permissions)
- 本アプリ: `README.md`、`docs/README.md`、`docs/external_design.md`、`docs/loop_feature.md`、`docs/checkpoint-and-smoke-design.md`、実装・テスト・CI・直近15 commit

記号は `◎`=同等の中核機能あり、`○`=一部あり、`—`=同等機能なし。製品面が異なる機能は、欠落だけで直ちにバグとは判定しない。

## 2. 機能比較マトリックス

| 機能領域 | Codex | Claude Code | lllmAgents（変更前） | 判定 |
|---|---|---|---|---|
| リポジトリ指示・永続メモリ | `AGENTS.md`、Memories | `CLAUDE.md`、rules、auto-memory | `CLAUDE.md`、rules、`/memory` | ◎ |
| スキルの発見・明示実行 | Skills / plugins | Skills / plugins | 組み込み・user・project skills、`skill` tool | ◎ |
| カスタムサブエージェント | agent config、model/effort/sandbox/MCP | agent frontmatter、model/tools/hooks/memory | Markdown定義、model slot、tool allowlist、max turns | ◎ |
| **サブエージェントへのスキル事前ロード** | agent configで`skills.config`を継承・上書き可能 | frontmatter `skills` で全文を起動時注入 | `context:fork` skillはあるが、agent定義・`task`からのpreload不可 | **— (GAP-01)** |
| 並列・バックグラウンド委任 | parallel subagents | subagents / agent view / agent teams | `task(run_in_background)`、`task_output`、並列上限 | ○ |
| worktree分離 | 独立chat・scheduled taskのworktree | session / subagent worktree | shadow Git checkpointのみ。並列編集の分離なし | — (GAP-02) |
| agent間協調 | parent集約、steer/stop | agent teams、cross-session messaging | parent集約。peer messagingなし | ○ |
| MCP | local / remote MCP | local / remote MCP | MCP client/manager、runtime ON/OFF | ◎ |
| Hooks | lifecycle hooks | command/prompt/HTTP/agent hooks | command hooks (Pre/PostTool、Session) | ○ |
| 権限・sandbox | profiles、approvals、OS sandbox | allow/ask/deny、permission modes | rules、autorun、Seatbelt/bwrap/WSL、channel bridge | ◎ |
| plan・長期ゴール | modes、long-running goals | plan、goals | `/plan`、Goal Seek、決定的check | ◎ |
| checkpoint / rewind | Record & Replay | `/rewind` | shadow Git `/checkpoint`、session resume | ○ |
| Web・browser・画像 | web/browser/computer/image | web/browser/image | web search/fetch、Playwright、vision/image generation | ◎ |
| 定時プロンプト | Desktop/Web Scheduled tasks | `/loop`、CronCreate/List/Delete | `/loop`のprocess内反復。agent tool・resume永続化なし | ○ (GAP-03) |
| remote / chat surface | Remote、Slack等 | remote control、channels | Discord/Slack Gateway、Room A/B/C | ○ |
| 配布可能なplugin bundle | skills/MCP/UI plugin | skills/agents/hooks/MCP plugin | 個別loaderはあるが統合bundle/marketplaceなし | — (GAP-04) |
| コスト・複数provider | usage表示、OpenAI models | usage表示、Claude providers | local/API複数provider、main/second/model slots、`/cost` | ◎（独自強み） |

## 3. 発見事項と終端方針

| ID | 優先度 | 証拠・影響 | 終端方針 |
|---|:---:|---|---|
| GAP-01 | P2 | agent定義が`tools`/`allowedTools`/`model`までしか読まず、特定ワークフローを必須にした専門agentでもスキルを自動注入できない。親が毎回skill本文を転記する必要があり、委任の再現性が落ちる | **今回実装**。frontmatter固定指定と`task`呼出時指定の両方を追加し、無効・不存在skillはLLM起動前に明示失敗させる |
| GAP-02 | P2 | parallel agentが同じworktreeを共有する。独立タスクの並列化はできるが、競合編集を隔離する保証はない | **今回範囲外**。現在の製品仕様はworktree分離を標榜せず、読取agent・対象分割で安全に運用可能。追加にはbranch所有・成果取込・未コミット変更・Windows Gitの一体設計が必要で、本サイクルのskill-context境界を変更しない |
| GAP-03 | P2 | `/loop`はユーザー操作のprocess内タイマーで、モデル用Cron toolとresume永続化がない | **今回範囲外**。ユーザー向け定期実行の中核は既にあり、本変更のagent contextと独立。Room帰属・idle時発火・失効・永続化をまとめた別設計が必要 |
| GAP-04 | P3 | skills/agents/hooks/MCPを1単位で配布するplugin manifest/marketplaceがない | **今回範囲外**。個別拡張は利用可能で中核CLI品質を阻害しない。署名・信頼・更新・競合解決を含む配布製品の別境界 |

レビュー時点で再現可能なP0/P1不具合は発見していない。GAP-02〜04は、今回の完了条件である「類似機能の欠落を最低1件追加」と品質ゲートを妨げず、上記の製品境界を根拠に終端を「範囲外」とする。

## 4. GAP-01 改善設計

1. agent Markdown frontmatterにoptional `skills: [skill-a, skill-b]`を追加する。既存定義は未指定のため挙動不変。
2. `task` toolにもoptional `skills: string[]`を追加し、その呼出だけの追加preloadを可能にする。agent定義分と呼出分は順序を保って重複除去する。
3. 有効な`SkillRegistry`から名前/triggerを解決し、`${SKILL_DIR}`を実パスへ置換して、元agent system prompt末尾へ識別可能な境界付きで全文注入する。
4. skill directoryを既存sandbox許可へ追加する。存在しない、または無効化されたskillは黙って省略せず、モデル呼出前にskill名付きで失敗する。
5. preloadはsystem promptだけへ入り、メイン会話履歴や別subagentへ漏らさない。`context:fork`の既存skill実行は変更しない。
6. 回帰テストはfrontmatter parse、固定+呼出指定の順序・重複除去、`${SKILL_DIR}`、missing/disabled fail-loud、providerが受け取るsystem promptを確認する。

## 5. 変更前ベースライン

- `npm.cmd run lint`: exit 0、既存warning 283件・info 103件
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: unit 92 files passed / 3 skipped、1102 tests passed / 24 skipped。E2E 3/3 passed
- sandbox内のVitest起動は、esbuildがリポジトリ上位を走査してaccess deniedとなる既知の環境制約。許可済みの制限外実行では成功
- 作業開始時のユーザー所有変更: `sandbox/`配下の未追跡6群。変更・stage対象外

## 6. 実装・評価結果

### 6.1 実装

- `AgentDefinition`へ`skills`を追加し、agent Markdownのflow配列を既定空配列で読み込むようにした。
- `task.skills`とagent定義の`skills`を、定義順→呼出順で重複除去して有効な`SkillRegistry`から解決する。
- 解決したskill本文をsubagentだけのsystem promptへ境界付きで注入し、`${SKILL_DIR}`を実ディレクトリへ置換してsandbox許可へ追加する。
- missing / disabled skillはモデル呼出前にskill名付きで失敗する。既存`context:fork`は専用system promptを維持し、agent定義のpreloadを混ぜない。
- `README.md`、外部・内部設計、CHANGELOG、docs索引を実装と同期した。変更後のGAP-01は`◎`相当。

### 6.2 ローカル評価

| Gate | 結果 |
|---|---|
| 対象回帰 | 4 files / 30 tests passed。frontmatter、固定+呼出preload、順序・重複除去、`${SKILL_DIR}`、missing/disabled、`task` foreground配線、既存budget/usageを確認 |
| `npm.cmd run lint` | passed。TypeScript error 0。warning 282 / info 102で変更前283 / 103から悪化なし |
| `npm.cmd run validate:skills` | product-quality-cycle / demo-skillともpassed |
| `npm.cmd run test:coverage` | 93 files passed / 3 skipped、1107 tests passed / 24 skipped。Statements 35.99%、Branches 75.89%、Functions 59.25%、Lines 35.99%、全閾値passed |
| `npm.cmd run test:e2e` | CLI非TTY smoke 3 / 3 passed |
| `npm.cmd run build` | passed |
| `npm.cmd run build:deploy` | passed。Windows SEA、CJS、skills 19件、agents 5件を生成 |
| 配布smoke | SEA / CJSの`--version`成功、agent 5件・skill 19件を確認。CJS bundleにpreload解決・注入コードを確認 |
| 実行ログ分析 | `analyze:loop --since 2026-08-25`を実行。本番セッション0件（test/mockは既定除外）、stuck-loop 0件。追加の運用品質所見なし |

実装commit後にも同じ配布build/smokeを再実行し、SEA / CJSとも履歴書換え前の`localllm v0.4.0 (8f0b337)`（現`53c38d6`とtree同一）、agents 5件・skills 19件、新preloadコード同梱を確認した。

## 7. 終了判定

- 未解決P0/P1: 0
- GAP-01: 回帰・全体・配布ゲートを通過し修正済み
- GAP-02 / 03: P2、GAP-04: P3。いずれも§3の製品境界を根拠に今回範囲外で終端
- latest push SHAのGitHub Actions全job成功を最終完了条件として継続する

## 8. Push後CI判定

実装commit `53c38d68fe84a14827a7909c333f57dd9af4b66a`（CI実行時の旧SHA `8f0b337b4c16a42ea82448e6fc1dabea717bdbb4`）のGitHub Actions run
[`32902955413`](https://github.com/t2k2pp/lllmAgents/actions/runs/32902955413) は、Ubuntu・macOS・Windowsの
test matrix 3 jobと、その全成功後にだけ起動するWindows deploy / exe smokeがすべて成功した。

このCI結果を残す本記録commitが新しいcompletion candidateとなる。記録commitも同じ全依存jobを監視し、
成功したrun URLと最新SHAを最終handoffに明記する。これにより、記録後の未監視commitを残さずサイクルを閉じる。
