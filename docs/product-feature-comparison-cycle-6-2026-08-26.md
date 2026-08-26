# Codex / Claude Code 機能比較・商品品質改善サイクル 6

Status: in-progress (latest pushed SHAの全CI job成功を最終gateとする)

- 実施日: 2026-08-26
- 基準 commit: `7d408889d4ed1c4f9364a978fcc87262d4f3468a`
- 観点: Codex / Claude Codeに類するlocal開発agentとしての機能充足、診断性、安全性、正しさ、運用性、UX、配布可能性
- 対象: repo全体の比較、startup customization境界、system prompt、skills/agents/rules/hooks/MCP/plugins、文書、test、配布物
- 完了条件: 公式一次資料に基づく比較表を残し、類似機能のない重要な抜けを一つ以上実装する。回帰・全unit・E2E・lint/typecheck・coverage・build・配布smoke・最新push SHAのCIを通し、未解決P0/P1を残さない

## 1. 比較基準と証拠

外部仕様は2026-08-26に次の一次資料を確認した。

- OpenAI Docs: [Codex permissions](https://learn.chatgpt.com/docs/permissions)、[Codex environments](https://learn.chatgpt.com/docs/environments/modes)
- Anthropic: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- 本アプリ: `README.md`、`docs/README.md`、外部・内部設計、直近15 commit、既存比較cycle 1〜5、実装・test・CI、2026-08-26以降の運用ログ集計

Codexはlocal commandのfilesystem/network境界をpermission profileで切替できる。Claude Codeは
`--safe-mode`でCLAUDE.md、skills、plugins、hooks、MCP、custom agents、auto memory等を一括停止し、
authentication、model selection、built-in tools、permissionsを維持する。本アプリは変更前、
`--no-mcp`と`--no-skills`はあるが、壊れたcustomizationを解析前に一括隔離する復旧経路がなかった。

記号は`◎`=同等の中核機能あり、`○`=一部あり、`—`=同等機能なし。

## 2. 機能比較マトリックス

| 機能領域 | Codex | Claude Code | lllmAgents（変更前） | 今回後 | 判定 |
|---|---|---|---|---|---|
| repository指示・memory | `AGENTS.md`、Memories | `CLAUDE.md`、auto memory | 複数instruction形式、`/memory` | 同左 | ◎ |
| skills / plugins / custom agents | skills、plugins、subagents | skills、plugins、subagents | skills、local plugin bundle、Markdown agents | 同左 | ◎ |
| parallel / background / steer | subagents、follow-up | background agents、follow-up | task list/output/send/cancel | 同左 | ◎ |
| permission / sandbox | reusable permission profiles、OS sandbox | permission modes、sandbox | rules、autorun、Seatbelt/bwrap/WSL | 同左 | ◎ |
| **customization切り分け起動** | permission/configをsurface別制御（専用一括safe modeは公式資料で未確認） | `--safe-mode`でcustomizationを一括停止 | `--no-mcp` / `--no-skills`のみ。plugin、hook、instructions、memory、agents、rulesは残る | `--safe-mode`で全customization surfaceを解析前に停止 | **◎ (GAP-07解消)** |
| built-in診断 | troubleshooting、permission visibility | `claude doctor`、safe mode | `/doctor` | 同左 | ◎ |
| MCP / hooks | MCP、hooks | MCP、多種hook | MCP、command hooks | 同左 | ○ |
| plan / long-running / schedule | plan、goals、scheduled tasks | plan、tasks、Cron | plan、Goal Seek、schedule tools | 同左 | ◎ |
| checkpoint / rewind | Record & Replay | `/rewind` | shadow Git checkpoint、resume | 同左 | ○ |
| worktree分離 | local worktree chat | session/subagent worktree | shadow Git checkpointのみ | 同左 | — (GAP-02) |
| structured non-interactive output | SDK / non-interactive surfaces | JSON / stream-json / JSON schema | pipe modeはtext中心 | 同左 | ○ (GAP-08) |
| web / browser / image | web/browser/image | web/browser/image | search/fetch、Playwright、vision/image | 同左 | ◎ |
| remote / chat | Remote、Slack等 | remote control、channels | Discord/Slack、Room A/B/C | 同左 | ○ |
| plugin marketplace / update | plugin directory | marketplace、install/update | local明示bundleのみ | 同左 | — (GAP-04B) |
| cost / multi-provider | usage、OpenAI models | usage、Claude providers | local/API複数provider、model slots、`/cost` | 同左 | ◎（独自強み） |

## 3. 発見事項と終端方針

| ID | 優先度 | 証拠・影響 | 終端方針 |
|---|:---:|---|---|
| GAP-07 | P2 | customizationがstartup/system prompt/tool lifecycleへ分散し、1つの壊れたplugin/hook/MCP/instructionを切り分けるため通常起動と個別編集が必要。壊れたplugin pathはstartup自体を止める | **今回実装**。解析前に全customization surfaceを止めるtransient safe modeを追加 |
| SAFE-REG-01 | P1 | 初期起動だけ抑止してもresume/model変更/Room切替/input compressionでproject指示やmemoryが再注入されるとsafe modeの安全境界が破れる | **今回予防修正**。全system prompt再構築を同じimmutable safe-mode flagへ接続し、input compressionを不活性化 |
| SAFE-REG-02 | P1 | 起動時だけMCPをOFFにすると、REPLの`/mcp on`、reload、server toggleから同一session内で再有効化できる | **評価中に発見・今回修正**。`MCPManager`にsession lockを設け、REPL操作・直接APIの双方で再有効化と設定永続化を拒否 |
| DOC-01 | P2 | `docs/changelog-feature-backlog.md`が実装済み`/doctor`を未実装と記載し、次の優先順位判断を誤らせる | **今回修正**。CL-02とCL-04の状態・結果を同期 |
| GAP-02 | P2 | parallel agentの編集をworktreeで隔離しない | **今回範囲外**。今回のstartup recovery境界とは独立し、既存checkpointとbranch/成果取込のownership設計を要するroadmap項目 |
| GAP-08 | P2 | machine-readable non-interactive outputが限定的 | **今回範囲外**。REPL recoveryとは別のautomation/API surfaceであり、schema・stream event互換を独立設計する |
| GAP-04B | P2 | remote marketplace/install/update/署名がない | **今回範囲外**。明示local bundleとは異なるsupply-chain trust境界 |

変更前・変更後とも再現可能なP0はない。SAFE-REG-01/02はsafe modeを商品機能として成立させるため今回の
完了条件に含め、初期化だけでなくsystem prompt再構築とruntime再有効化の経路を閉じる。

## 4. 改善設計と実装

詳細設計は`docs/safe-mode-design.md`を正本とする。

1. `src/cli/startup-mode.ts`を全customization surfaceの単一policy sourceにする。
2. safe modeではplugin directoryを収集・検証せず、skills/hooks/MCPをload/connectしない。
3. built-in agent/ruleは残し、user/project/plugin定義だけをloader境界で除外する。
4. `AgentLoop`にimmutable flagを渡し、初期化、profile更新、resume、Room新規会話、compression ON/OFFの全system prompt再構築でproject instruction・memory・custom ruleを空に保つ。
5. `--plugin-dir`等よりsafe modeを優先し、configを変更せずactive状態をwelcome前に表示する。
6. MCPはprocess lifetimeのsession lockで固定し、REPLやmanager APIからの再有効化を拒否する。

## 5. 変更前ベースライン

- `npm.cmd run lint`: exit 0、既存warning 281件・info 103件
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: unit 98 files passed / 3 skipped、1151 tests passed / 24 skipped。E2E 3/3 passed
- `npm.cmd audit --omit=dev --audit-level=high`: 0 vulnerabilities
- `npm.cmd run analyze:loop -- --since 2026-08-26`: 本番session 0件、user span 0件、stuck-loop 0件。prompt/response原文は取得・転載していない
- sandbox内testはesbuildがrepository上位directoryを走査してaccess deniedとなる環境制約。許可済みの制限外実行では成功
- 作業開始時のuser所有変更: `sandbox/`配下の未追跡6群。変更・stage対象外

## 6. 評価結果

### 6.1 TDD・対象回帰

- 実装前に`tests/cli/startup-mode.test.ts`がmodule不存在で失敗することを確認した。
- 対象unit: startup policy、built-in-only agent/rule、hook/MCP session lock、全system-prompt再構築を検証する回帰testがpassed。
- E2E: safe mode scenarioはmissing plugin directory、broken MCP JSON、SessionStart hook、project instruction/rule、user memoryを同時配置し、startup成功、hook未実行、prompt未混入、`/mcp on`拒否とconfig非変更を確認した。

### 6.2 全体品質gate

| Gate | 結果 |
|---|---|
| `npm.cmd run lint` | passed。TypeScript error 0、warning 281 / info 103でbaseline同数 |
| `npm.cmd run test:coverage` | 100 files passed / 3 skipped、1158 tests passed / 24 skipped。Statements/Lines 37.85%、Branches 76.47%、Functions 61.79%、全threshold passed |
| `npm.cmd run test:e2e` | 4/4 passed |
| `npm.cmd run validate:skills` | product-quality-cycle / demo-skillともpassed |
| `npm.cmd run build` | passed |
| `npm.cmd run build:deploy` | Windows SEA / CJS、skills 19件、agents 5件を生成 |
| `npm.cmd audit --omit=dev --audit-level=high` | 0 vulnerabilities |

live API credential、remote plugin、実MCP serverは使用していない。cross-OSの実行証拠はpush後CIで確認する。

## 7. Finding終端とCI closure

- GAP-07、SAFE-REG-01、SAFE-REG-02、DOC-01: 実装・回帰・全local gateで解消。
- GAP-02、GAP-08、GAP-04B: §3の独立した製品境界を根拠に、このstartup recovery cycleの範囲外で終端。既存機能や今回の品質gateを阻害しないroadmap項目。
- 未解決P0/P1: 0。
- user所有の`sandbox/`未追跡6群は変更・stageしていない。
- commit後に配布物を再buildし、そのSHAを埋め込んだSEA/CJS smokeを行う。`origin/main`へpushした最新SHAのGitHub Actions全依存job成功を最終完了条件とする。
