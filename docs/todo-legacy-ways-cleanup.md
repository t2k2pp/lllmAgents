# ToDo: 同じことをする複数のやり方 (旧方式の残り) を一本化する

> 作成日: 2026-10-25 / ステータス: **未着手** (`/run pause` 一本化の後に着手)

## 背景
`/run pause` と `/run pause --durable` のように、同じ目的に 2 つのやり方が残っていると、
表記ゆれと同じく「別物なのか同じものなのか」 が分からず、 使い分けを誤る (2026-10-25 myppt で作業記録を失いかけた)。
過去の改修でも、 新方式を入れた時に旧方式を互換のために残した箇所がある疑いがある。

## 方針 (設計思想)
- 同じことをするやり方は 1 つにする。 新方式に置き換えたら旧方式は削除する (互換レイヤー・alias を残さない)
- 判断基準: 「利用者・モデルから見て同じ目的か」。 目的が違うなら名前と説明で違いを明示する
- 削除と同時に docs・help・補完・テスト・スキル (src/skills/builtin) を 1 つのやり方に揃える

## ToDo
- [ ] 洗い出し: slash command / CLI オプション / config キー / ツール (モデル向け) / スキル / 設計書の用語で、
      同じ目的の別名・旧方式・alias・後方互換コードを列挙する (例: コード中の「後方互換」「旧シグネチャ」「alias」「deprecated」 の検索から)
- [ ] 1 件ずつ「同じ目的か / 残す理由があるか」 を判定し、 一覧を本書に表で残す
- [ ] ユーザーに一覧を見せて削除対象を確定する
- [ ] 削除・統合を実装し、 docs / help / テストを揃える

## 洗い出し結果 (2026-10-25)

調査はコード上の確認による。 主要な指摘 (ヘルプに削除済みコマンド、 旧コマンドが動作、 todo_write の登録) は再確認済み。

### A. 同じ機能の別名・旧方式 (削除する)
| 対象 | 残す方 | 備考 |
|---|---|---|
| `/second ...` | `/model second ...` | 「`/second setup` で設定」 の案内文が repl.ts・claude-cli.ts・federated-delegate.ts (モデル向け説明) に残る。 一緒に直す |
| `/sessions` / `/continue` | `/resume list` / `/resume latest` | `/help` が旧名を載せている |
| `/profiles` / `/profile` | `/models` | 旧 UI (handleProfilesCommand) のまま。 llm-profiles.ts facade も撤去 |
| `/model-registry` / `/registry` | `/models` | 補完に出ない隠れ alias |
| `/integration` | `/integrations` | `/intg` は C で判断 |
| `/switch` | `/swap` | |
| `/token` | `/cost` | |
| `/model url` / `/model ip` | `/model host` + `/model port` | second 側は `url` しか無いので host/port に揃える |
| `/loop list` | `/loop status` | |
| `/discord public-key` / `/discord port`、 設定 `discord.publicKey` / `interactionPort` | (なし) | 何もしない残骸 |
| `--no-alt-screen` / `--no-mouse` | 既定 (off) | 環境変数を打ち消す用途が無いか確認してから |
| `todo_write` ツール | `todo_append` / `todo_mark` / `todo_delete` | 先に WORKTREE_AGNOSTIC_CORE・既定 autoApprove・plan-mode・todoWriteCount を新ツールに対応させる |
| `/help` の不整合 | 補完 (registry) と同じ一覧 | 削除済み `/capability` `/metrics` が載っている。 `/skills` が 2 行 |
| ツール名の別名表 2 つ (rule-engine.ts / skill-loader.ts) | 1 つに統合 | rule-engine の `agent→sub_agent` は実在しない名前 (実際は `task`) |
| コード上だけの互換 | (なし) | agent-loop の未使用引数 compressionThreshold、 composer の文字列戻り値、 `webSearchTool` export、 `getDisplayWidth` 再 export 等 |

### B. 違う目的なので残す (説明で違いを明記)
`/room resume` と `/resume latest`、 `/compact` と `/forget`、 `--no-skills`/`--no-mcp` と `/skills off`/`/mcp off`、
`federated_delegate` と `second_llm_agent`、 `/model <name>` と `/model list`、 ask_user の options 文字列許容、 スキルの `tools`/`allowed-tools`。

### C. ユーザー判断が必要
1. 権限の二重構造: `security.autoApproveTools`/`requireApprovalTools` (ツール名一覧) と `security.rules` (allow/deny/ask パターン、 一覧より優先)
2. 起動フラグ `--continue`/`--resume` と REPL の `/resume latest`/`/resume <id>` の名前揃え
3. `/permission` の隠れた旧サブコマンド (auto-add 等) と、 `/discord` `/slack` `/search` `/chatlog` の直接コマンド (`/integrations` 画面が内部で呼んでいる)
4. config の `mainLLM`/`secondLLM`/`visionLLM` と model-registry の slots の二重管理 (起動のたびに突き合わせ)
5. `/stream on|off` (補完から隠れている) と引数なし `/stream`、 `/intg`、 `--mouse` が `--alt-screen` も有効にする暗黙の重なり

### D. 古い保存データを読むための互換 (当面残す)
config.json のシークレット分離移行、 llm-profiles.json → registry 移行、 Room 導入前の旧セッション読込、 単独 .md の旧スキル、 `modelCapabilities.maxIterations` 廃止警告。
