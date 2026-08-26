# Codex / Claude Code 機能比較・商品品質改善サイクル 5

Status: local-completed / CI pending

- 実施日: 2026-08-26
- 基準 commit: `b3120548eda42e84c6ecd40ab425355cc921c831`
- 観点: Codex / Claude Codeに類するローカル開発agentとしての機能充足、安全性、正しさ、運用性、UX、配布可能性
- 対象: repo全体の比較、plugin bundle、skill / agent / hook / MCP統合、設定、文書、テスト、配布物
- 完了条件: 一次資料に基づく比較表を作成し、重要な機能抜けを一つ実装する。回帰・全unit・E2E・lint/typecheck・coverage・build・配布smoke・最新push SHAのCIを通し、未解決P0/P1を残さない

## 1. 比較基準と証拠

外部仕様は2026-08-26に次の一次資料を確認した。

- OpenAI: [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)、[Package a plugin](https://developers.openai.com/plugins/build/plugins)
- Anthropic: [Create plugins](https://code.claude.com/docs/en/plugins)、[Plugins reference](https://code.claude.com/docs/en/plugins-reference)、[Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- 本アプリ: `README.md`、`docs/README.md`、外部・内部設計、実装・テスト、直近commit、2026-08-26以降の運用ログ集計

Codex pluginはmanifestを持つdirectoryにskills、MCP、hooks等をまとめる。Claude Code pluginもmanifestを中心にskills、agents、hooks、MCP、LSP等を配布する。本アプリは変更前、それぞれのloaderを持つ一方、team機能を一単位で明示的に読み込むmanifest境界がなかった。

記号は `◎`=同等の中核機能あり、`○`=一部あり、`—`=同等機能なし。製品面が異なる機能は、欠落だけで直ちに不具合とは判定しない。

## 2. 機能比較マトリックス

| 機能領域 | Codex | Claude Code | lllmAgents（変更前） | 今回後 | 判定 |
|---|---|---|---|---|---|
| repository指示・永続memory | `AGENTS.md`、Memories | `CLAUDE.md`、rules、auto-memory | `CLAUDE.md`、rules、`/memory` | 同左 | ◎ |
| skills・custom agents | skills、custom agents | skills、subagents | skills、Markdown agents、preload skills | 同左 | ◎ |
| parallel / background / steer | subagents、follow-up | subagents、teams、follow-up | background task、list/cancel/output/send | 同左 | ◎ |
| worktree分離 | agent worktree | session/subagent worktree | shadow Git checkpointのみ | 同左 | — (GAP-02) |
| MCP / hooks | MCP、command hooks | MCP、多種hook | MCP、command hooks | pluginからも統合 | ○ |
| permission / sandbox | approvals、OS sandbox | allow/ask/deny、permission modes | rules、autorun、Seatbelt/bwrap/WSL | 同左 | ◎ |
| plan / long-running goal | plan、goals | plan、tasks | `/plan`、Goal Seek、決定的check | 同左 | ◎ |
| checkpoint / rewind | Record & Replay | `/rewind` | shadow Git `/checkpoint`、resume | 同左 | ○ |
| web / browser / image | web/browser/image | web/browser/image | search/fetch、Playwright、vision/image | 同左 | ◎ |
| schedule | scheduled tasks | `/loop`、Cron tools | `/loop`、schedule tools | 同左 | ◎ |
| remote / chat | Remote、Slack等 | remote control、channels | Discord/Slack、Room A/B/C | 同左 | ○ |
| **local plugin bundle** | manifest + skills/MCP/hooks | manifest + skills/agents/hooks/MCP | 個別loaderのみ | 明示dirのmanifest bundle | **○ (GAP-04解消)** |
| marketplace / install / update | plugin directory | marketplace、install/update | なし | なし | — (GAP-04B) |
| LSP / plugin UI | app UIを同梱可能 | LSPを同梱可能 | host surfaceなし | 同左 | — (GAP-06) |
| cost / multi-provider | usage、OpenAI models | usage、Claude providers | local/API複数provider、model slots、`/cost` | 同左 | ◎（独自強み） |

## 3. 発見事項と終端方針

| ID | 優先度 | 証拠・影響 | 終端方針 |
|---|:---:|---|---|
| GAP-04 | P2 | team固有のskill/agent/hook/MCPを個別配置する必要があり、再利用可能な配布・有効化単位がない | **今回実装**。native manifestとCodex/Claude最小互換manifestを持つlocal bundleを追加 |
| PLUGIN-SEC-01 | P1 | repo内pluginの自動探索は、未信頼hook/MCP commandの暗黙実行につながる | **今回予防修正**。config/CLIの明示dirだけを読み、root containment・実path・件数・重複・namespaceを検証 |
| PLUGIN-SEC-02 | P1 | componentだけでなくmanifest directory自体がjunction/symlinkでroot外へ抜けられた | **今回修正**。失敗する境界テストを追加し、manifestのrealpathもroot内へ制限 |
| DOC-01 | P2 | READMEのhook読込順が実装のproject→globalと逆で、運用時の実行順を誤認させる | **今回修正**。READMEを実装順とplugin追加順へ同期 |
| GAP-02 | P2 | parallel agentの編集をworktreeで隔離しない | **今回範囲外**。branch所有、未commit変更、成果取込、cross-OS Gitを含む独立した製品境界 |
| GAP-04B | P2 | marketplace、download/install/update、署名がない | **今回範囲外**。remote取得とsupply-chain trustはlocal明示読込と別の安全境界 |
| GAP-06 | P3 | plugin UI/LSP hostがない | **今回範囲外**。CLI中心のsurfaceではlocal workflow bundleの価値を妨げない |

## 4. 改善設計

1. plugin rootに`.localllm-plugin/plugin.json`を置く。移行用に同じ最小fieldの`.codex-plugin/plugin.json`と`.claude-plugin/plugin.json`も一つだけ受理する。
2. `config.pluginDirs`または反復可能な`--plugin-dir`だけを有効化経路とし、自動探索しない。
3. manifestを1 MiB以下のUTF-8 JSON、plugin名を64文字以下のkebab-caseに制限する。最大32件、同名、複数manifest、root外path、symlink/junction escapeは起動前に拒否する。
4. skill/agentは`plugin:component`、MCP serverは`plugin__server`へ名前空間化し、既存定義を上書きさせない。plugin agentの未修飾preload skillも同じnamespaceへ解決する。
5. hook/MCP/agent本文の`${PLUGIN_ROOT}`だけを検証済みreal rootへ展開する。hookとstdio MCPはlocal commandを実行できるため明示指定を信頼境界とし、既存lifecycleを維持する。
6. JavaScript entrypointのin-process実行、remote marketplace、install/update、署名はv1に含めない。

詳細は`docs/plugin-bundle-design.md`を正本とする。

## 5. 変更前ベースライン

- `npm.cmd run lint`: exit 0、既存warning 282件・info 103件
- `npm.cmd run build`: passed
- `npm.cmd run test:all`: sandbox内ではesbuildの上位directory走査がaccess denied。制限外実行ではunit 96 files passed / 3 skipped、1132 tests passed / 24 skipped、E2E 3/3 passed
- `npm.cmd run analyze:loop -- --since 2026-08-26`: 対象となる本番session log 0件。prompt・応答原文は取得・転載していない
- `npm.cmd audit --omit=dev --audit-level=high`: 0 vulnerabilities
- 作業開始時のユーザー所有変更: `sandbox/`配下の未追跡6群。変更・stage対象外

## 6. 実装・評価結果

### 実装

- `PluginLoader`を追加し、manifest、明示dir収集、重複、UTF-8、サイズ、path containment、symlink/junctionを検証した。
- plugin skills、agents、hooks、MCPを既存registry/lifecycleへ統合し、それぞれをplugin名でnamespace化した。
- `${PLUGIN_ROOT}`展開とhook用`PLUGIN_ROOT`環境変数を追加した。
- config schema、CLI起動、sub-agent definition注入、README、設定・外部・内部設計、CHANGELOGを同期した。

### TDD・回帰評価

- plugin module未実装、agent/hook/MCP未統合、manifest symlink未防御の各段階で先行テストの失敗を確認してから実装した。
- 対象回帰: 6 files、87 tests passed。3種manifest、CLI/config収集、名前空間、preload skill、hook/MCP統合、UTF-8、1 MiB、重複、曖昧manifest、`..`/絶対path/symlink escapeを検証した。
- 全unit + coverage: 98 files passed / 3 skipped、1151 tests passed / 24 skipped。coverageはstatements 37.46%、branches 76.41%、functions 60.44%、lines 37.46%。
- E2E: 3/3 passed。
- lint/typecheck: exit 0、warning 281件・info 103件。baseline比warning 1件減、新規errorなし。
- `npm.cmd run build`: passed。
- `npm.cmd run build:deploy`: Windows SEA / CJSともpassed。両配布CLIの`--version`がexit 0で、CJS bundleにplugin初期化、`--plugin-dir`、native manifest識別子が含まれることを確認した。
- `npm.cmd run validate:skills`: `product-quality-cycle` / `demo`ともpassed。
- `npm.cmd audit --omit=dev --audit-level=high`: 0 vulnerabilities。
- live API credentialやremote plugin取得は使用していない。local filesystem境界を決定的テストで評価した。

### Finding終端

- GAP-04、PLUGIN-SEC-01、PLUGIN-SEC-02、DOC-01: 実装・回帰・全local gateで解消。
- GAP-02、GAP-04B、GAP-06: 比較表に残すP2/P3の製品roadmap項目。今回のP0/P1残件はない。
- ユーザー所有の`sandbox/`未追跡fileは変更・stageしていない。

## 7. CI closure

- 実装commit / push / workflow: pending
- 最新push SHAの全依存jobが完了するまで監視し、結果をclosure commitとhandoffへ記録する。
