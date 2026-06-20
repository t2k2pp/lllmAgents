# 外部統合コマンド（/integrations）統廃合クリーンアップ

作成日: 2026-06-20 / 関連: `docs/channel-interaction-bridge-design.md`

## 1. 背景

`/discord` `/slack` `/chatlog` `/search` の 4 つの外部統合コマンドは
2026-05-28 の Phase optimize #3 で `/integrations`（`/intg` / `/integration`）に集約済み。
入口は `handleIntegrationsCommand`（`src/cli/repl.ts`）の picker で、選択に応じて
Discord / Slack / Chatlog / Search の各サブメニューへ分岐する。

集約後も以下の積み残しがあったため、本クリーンアップで解消する。

1. 旧 4 コマンドが REPL のコマンド補完ドロップダウンに `[非推奨]` ラベル付きで残り、
   ユーザーから見えていた（`/help` 側は `/integrations` のみ表示済みでクリーン）。
2. `/discord` / `/slack` の「許可ユーザーリスト」(`allowedUserIds`) 操作が
   `/integrations` メニューに載っておらず、GUI 導線が断絶していた。
3. 調査の副産物として `case "/skills"` の二重定義（到達不能な dead code）を発見。

## 2. 各コマンドの役割と `/integrations` 統合状況

全コマンドの実体は dispatcher の `case` に残り、`/integrations` の各サブメニューが
`this.handleCommand("/<cmd> <sub>")` を内部呼び出しする構造になっている。
**そのため dispatcher の case は実装本体として全て必須**であり、削除しない。

| 旧コマンド | 機能 | 主なサブコマンド (dispatcher) | サブメニュー | クリーンアップ前の網羅性 |
|---|---|---|---|---|
| `/discord` | Discord 連携（通知 + チャンネル⇄エージェント橋渡し） | status / enable / disable / url / test / app-id / bot-token / register / listen / **users / user-add / user-remove** / images | `integrationsDiscordMenu` | **不足**: 許可ユーザー操作が無かった |
| `/slack` | Slack 連携（同上） | status / enable / disable / url / test / bot-token / app-token / **users / user-add / user-remove** | `integrationsSlackMenu` | **不足**: 同上 |
| `/chatlog` | 会話ログを Obsidian Vault へ保存 | status / enable / disable / vault `<path>` | `integrationsChatlogMenu` | **完全**（enable/disable/vault を網羅） |
| `/search` | Web 検索エンジン切替 | status / duckduckgo (ddg) / searxng `<url>` / test | `integrationsSearchMenu` | **完全**（ddg/searxng/test を網羅） |

要点:
- `/chatlog`・`/search` は `/integrations` 側に機能欠落が無いため、対応は「補完候補から外す」だけ。
- `/discord`・`/slack` のみ、dispatcher に存在する許可ユーザー操作
  (`users` / `user-add` / `user-remove`) がメニューに無く、本クリーンアップで追加した。
  - 許可ユーザーリスト (`allowedUserIds`) の意味は `docs/channel-interaction-bridge-design.md §6` 参照。
    未設定なら全員が利用可能、設定すると当該ユーザーのみがエージェントを呼び出せる。

## 3. 実施した変更

### A. 補完候補から旧 4 コマンドを除去 — `src/cli/completer.ts`
- `BUILTIN_COMMAND_DEFS` から `/discord` `/slack` `/chatlog` `/search` の `CommandDef` を削除。
- dispatcher の case は `/integrations` が内部呼び出しするため残置（実装専用）。
- 権限ツール用の正規表現（`/permission ... discord-add` / `discord-remove`）は外部統合とは
  無関係なので変更しない。

### B. 許可ユーザーリストを `/integrations` に統合 — `src/cli/repl.ts`
- `integrationsDiscordMenu` / `integrationsSlackMenu` に 3 項目を追加:
  - 「許可ユーザーを表示」→ `/discord users`（または `/slack users`）
  - 「許可ユーザーを追加」→ ID を `input` で受け取り `/<cmd> user-add <id>`
  - 「許可ユーザーを削除」→ ID を `input` で受け取り `/<cmd> user-remove <id>`
- 既存の入力取消パターン（空欄なら continue）を踏襲。項目増に合わせ `pageSize` を調整。

### C. 重複 `case "/skills"` の dead code 削除 — `src/cli/repl.ts`
- 後方にあった旧 `/skills` 一覧表示 case を削除。
  JS の switch は先頭の case のみ一致するため到達不能だった。
- 有効な `case "/skills"`（status / on / off / reload / toggle 版）を残す。
  `/skills status` が builtin/custom のタグ付き一覧と件数を表示するため機能欠落は無い。

## 4. dispatcher を残す理由（再掲）

`/integrations` の各サブメニューは内部で旧コマンド文字列を `handleCommand` に渡して
処理を委譲している。したがって旧コマンドの dispatcher 実装を消すと `/integrations` 自体が
壊れる。本クリーンアップは「ユーザーへの露出（補完）を整理する」ものであり、
内部実装は温存する方針。
