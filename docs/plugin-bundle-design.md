# ローカル plugin bundle 設計

Status: implemented

- 作成日: 2026-08-26
- 基準 commit: `e8485eed284ad7901244bddc2dd941de2de19dc6`
- 対象: skill、sub-agent、hook、MCPを一つの明示的に信頼したローカル配布単位として読み込む

## 1. 背景

Codexは `.codex-plugin/plugin.json` を中心にskillsとMCPを、Claude Codeは
`.claude-plugin/plugin.json` を中心にskills、agents、hooks、MCP等を配布単位へまとめる。
lllmAgentsには個別loaderはあるが、それらを一つのmanifestから有効化する境界がない。

一次資料:

- OpenAI: <https://developers.openai.com/plugins/concepts/plugins>
- OpenAI: <https://developers.openai.com/plugins/build/plugins>
- Anthropic: <https://code.claude.com/docs/en/plugins>
- Anthropic: <https://code.claude.com/docs/en/plugins-reference>

## 2. v1の製品境界

plugin rootには `.localllm-plugin/plugin.json` を置く。移行を容易にするため、同じ最小fieldを
持つ `.codex-plugin/plugin.json` と `.claude-plugin/plugin.json` も入力として受け付ける。

```json
{
  "name": "quality-tools",
  "version": "1.0.0",
  "description": "Team quality workflows",
  "skills": "./skills",
  "agents": "./agents",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}
```

- 有効化は `config.pluginDirs` または反復可能な `--plugin-dir <path>` だけ。自動探索しない。
- 相対plugin dirは起動時CWD基準。重複pathは一つにまとめ、同名pluginは起動前に失敗させる。
- manifestは1 MiB以下のUTF-8 JSON、`name`はkebab-case、component pathはplugin root内に限定する。
- manifest候補が複数あるbundleは曖昧さを黙認せず失敗させる。
- skillは `plugin-name:skill-name` / `/plugin-name:skill-name`、agentは
  `plugin-name:agent-name` として登録し、既存定義を上書きさせない。
- plugin agentの未修飾preload skillは同じplugin名前空間へ解決する。
- hook commandとMCPのcommand/args/envでは `${PLUGIN_ROOT}` を利用できる。
- MCP server名はtool名互換の `plugin-name__server-name` に名前空間化する。
- JavaScript entrypointのin-process実行、remote marketplace、download/install/update、署名はv1対象外。
- hookとstdio MCPはローカルcommandを実行できるため、plugin指定はbundleへの明示的な信頼表明として扱う。
  自動探索による暗黙実行は避け、既存のHookManager/MCP lifecycle自体は変更しない。

## 3. 起動時データフロー

1. CLIとsanitized configから明示plugin dirを収集する。
2. `PluginLoader`がmanifest、重複、UTF-8、サイズ、path containmentを検証する。
3. plugin skillを名前空間化して`SkillRegistry`へ登録する。
4. plugin agent sourceを`AgentDefinitionLoader`へ注入する。
5. plugin hook fileを`HookManager`へ、plugin MCP configを`MCPManager`へ追加する。
6. 既存のtool registry、session hook、MCP lifecycleをそのまま使う。plugin指定前の内容確認を利用者の信頼境界とする。

## 4. 品質ゲート

- manifest互換3形式、CLI/config path収集、UTF-8、1 MiB、重複名、曖昧manifestを回帰テストする。
- `..`、絶対path、symlink escapeを拒否する。
- skill/agent/MCPの名前空間化、agent内skill参照、`${PLUGIN_ROOT}` 展開を確認する。
- 未指定時は既存loaderの結果が変わらないことを確認する。
- 全unit、coverage、E2E、lint/typecheck、build、deploy/SEA smoke、CJS非混入検査、最新push SHAのCIを通す。
