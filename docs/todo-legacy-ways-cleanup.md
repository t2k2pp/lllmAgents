# ToDo: 同じことをする複数のやり方 (旧方式の残り) を一本化する

> 作成日: 2026-10-25 / ステータス: **実施中** (洗い出し・判断済み。 T1〜T4 完了、 T5 が残り)

## 背景
`/run pause` と `/run pause --durable` のように、同じ目的に 2 つのやり方が残っていると、
表記ゆれと同じく「別物なのか同じものなのか」 が分からず、 使い分けを誤る (2026-10-25 myppt で作業記録を失いかけた)。
過去の改修でも、 新方式を入れた時に旧方式を互換のために残した箇所がある疑いがある。

## 方針 (設計思想)
- 同じことをするやり方は 1 つにする。 新方式に置き換えたら旧方式は削除する (互換レイヤー・alias を残さない)
- 判断基準: 「利用者・モデルから見て同じ目的か」。 目的が違うなら名前と説明で違いを明示する
- 削除と同時に docs・help・補完・テスト・スキル (src/skills/builtin) を 1 つのやり方に揃える

## ToDo
- [x] 洗い出し: slash command / CLI オプション / config キー / ツール (モデル向け) / スキル / 設計書の用語で、
      同じ目的の別名・旧方式・alias・後方互換コードを列挙する (例: コード中の「後方互換」「旧シグネチャ」「alias」「deprecated」 の検索から)
- [x] 1 件ずつ「同じ目的か / 残す理由があるか」 を判定し、 一覧を本書に表で残す
- [x] ユーザーに一覧を見せて削除対象を確定する (2026-10-25、 下記「決定」)
- [ ] 削除・統合を実装し、 docs / help / テストを揃える (下記 T1〜T4)

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

## 決定 (2026-10-25 ユーザー判断)
- C1 権限: **`security.rules` (allow/deny/ask) に一本化**。 `autoApproveTools` / `requireApprovalTools` (と Discord/Slack 用の一覧) は rules へ移行して削除。 既存 config は起動時に 1 回だけ変換する
- C2 起動フラグ: **REPL に揃える**。 `--resume <id>` / `--resume latest`。 `--continue` は削除。 --help に載せる
- C3 設定コマンド: **対話画面に一本化**。 `/permission` の旧サブコマンド、 `/discord` `/slack` `/search` `/chatlog` の直接コマンドを削除し、 対話画面の内部は関数呼び出しにする。 非TTY での設定変更は config.json を直接編集
- C4 モデル設定の二重管理: **今は触らない** (別途設計)
- C5 (こちらで判断): `/stream on|off` と `/intg` は別名なので削除。 `--mouse` が `--alt-screen` も有効にする件は動作変更を伴うため記録のみ

## 実装タスク (順に 1 つずつ、 各タスクで CI 手順を通して push)
- [x] T1: A の削除 (コマンド別名・何もしない残骸・`/help` を補完と同じ一覧に・`todo_write`・ツール名別名表の統合・コード上だけの互換) + C5 (2026-10-25、 下記「T1 実施内容」)
- [x] T2: C2 起動フラグ + T1 で見えた入力検査 (`/model <名前>`・`/loop`) (2026-10-25、 下記「T2 実施内容」)
- [x] T3: C3 設定コマンドを対話画面に一本化 (2026-10-25、 下記「T3 実施内容」)
- [x] T4: C1 権限を rules に一本化 (2026-10-25、 下記「T4 実施内容」)
- [ ] T5: ドキュメントの最終確認 — README / docs (履歴の cycle-* 等を除く) / 組み込みスキル / `/help`・`--help` / モデル向けツール説明に、 T1〜T4 で削除・変更したコマンド・フラグ・ツール・設定キーが旧い書き方で残っていないか、 同じことに 2 つのやり方があるように読める説明が無いかを確認して直す。 履歴文書で現行仕様への注記が必要なものには注記を足す

## T1 実施内容 (2026-10-25)

### 削除したもの (互換 alias・案内 shim は残していない)
- コマンド: `/second` `/sessions` `/continue` `/profiles` `/profile` `/model-registry` `/registry` `/integration` `/intg` `/switch` `/token`、
  `/model url` `/model ip`、 `/loop list`、 `/stream on|off` (引数付き `/stream` は「引数を取りません」 と表示)、 `/discord public-key` `/discord port`
- `/profiles` の旧 UI (handleProfilesCommand / printProfilesList) と `src/config/llm-profiles.ts` (model-registry への委譲 facade)。
  `src/agent/llm-profiles.ts` (buildLLMProfiles) はシステムプロンプト用の実処理で別物なので残す
- 設定キー: `discord.publicKey` / `discord.interactionPort`、 `context.compressionThreshold` / `context.maxHistoryMessages` (どれも読まれていなかった)。
  config-schema は未知キーを検証対象外として読み飛ばすため、 既存 config.json に残っていても起動できる
- `todo_write` ツール。 先に WORKTREE_AGNOSTIC_CORE・既定 autoApproveTools・plan mode 許可一覧・general-purpose エージェントの tools を
  todo_append / todo_mark / todo_delete に置き換えた。 INHERENTLY_SAFE_TOOLS からも外した。
  計画/Todo 過多検知は todo_append / todo_delete (計画の書き換え) を数える (todo_mark は 1 項目ずつ進める通常操作なので数えない)
- コード上だけの互換: AgentLoop の未使用引数 `compressionThreshold`、 SystemPromptComposer の文字列戻り値、 `webSearchTool` export、
  interactive-input.ts の `getDisplayWidth` 再 export、 claude-agent-sdk の何もしない `attachToolBridge` (と config の toolRegistry / toolExecutor)

### 一本化・修正したもの
- second 側の接続先変更を main と同じ `/model second host` / `/model second port` にした (`/model second url` は削除)
- 削除したコマンドを指していた案内文 (`/second setup` 等。 federated_delegate のモデル向け説明、 システムプロンプトの second 特性未設定の案内を含む) を正規の書き方に直した
- `/help`: 削除済み `/capability` `/metrics`、 旧名、 `/skills` の重複を除き、 実在コマンドだけにした。 一覧は `BUILTIN_HELP_ENTRIES` (renderer.ts) に持ち、
  補完と一致していることを tests/cli/help-consistency.test.ts で検査する。 `/stream` `/permission` `/model second|vision` `/models` 等の抜けも補った
- ツール名の別名表: rule-engine.ts と skill-loader.ts の 2 つを `src/tools/tool-name-aliases.ts` に統合。 `Agent` は実在しない `sub_agent` ではなく `task` を指すよう直した (`Task` も同じ)
- C5: `/stream on|off` と `/intg` を削除。 `--mouse` が `--alt-screen` も有効にする件は記録のみ (変更なし)

### 確認した上で残したもの
- `--no-alt-screen` / `--no-mouse`: 環境変数 `LLLMAGENT_ENABLE_ALTERNATE_SCREEN` / `LLLMAGENT_ENABLE_MOUSE` を常用している人がその回だけ打ち消す用途がある。
  --help の「legacy compatibility」 表記をこの用途の説明に直した
- `/loop stop [id|all]`: `/loop status` の停止 picker と目的は重なるが、 picker を使えない非TTY でも止められる唯一の手段なので残し、 補完とヘルプに載せた (要ユーザー判断)
- `/discord` `/slack` `/search` `/chatlog` `/permission` の直接サブコマンド: T3 で削除 (下記「T3 実施内容」)
- 本表に無いが同種の別名として気づいたもの (未対応): `/quit` と `/exit`、 `/model second status|info` と引数なし `/model second`、
  `/model second model <名前>` と `/model second list`、 `/cost model|provider` (単数形) と `/cost models|providers`


## T2 実施内容 (2026-10-25)

### 起動フラグ (C2)
- 書き方は REPL と同じ `--resume <id>` / `--resume latest` の 2 つだけ。 `--continue` は削除 (互換 alias なし)。 `--help` に載せた
- 解釈は `src/cli/resume-flag.ts` (parseResumeFlag / resolveResumeFlag)。 画面・設定・MCP の初期化より先に解決し、 次の場合は何も始めずに終了コード 1 で終わる (黙って新規セッションで始めない)
  - 引数なし `--resume` (REPL の `/resume` は picker を開くが、 起動時は REPL 開始前で picker を出せないため使い方エラー)・次が別フラグ・`--resume` の重複
  - 見つからない ID、 `--resume latest` で保存セッションが無い
- `/quit` の再開案内とクラッシュ時の案内を `--resume latest` に直した。 README・external_design ほか設計書の `--continue` 表記を直した (cycle-* の履歴文書は触らない。 claude-code-driver スキル内の `--continue` は Claude Code CLI 自身のフラグなので対象外)

### 入力検査 (T1 で露見した分。 削除したコマンド名の特別扱いはしていない)
- `/model <名前>`: 1 語のみ・プロバイダーのモデル一覧 (`/model list` と同じ取得元) にある名前のみ切り替える (`src/cli/model-name-check.ts`)。
  余分な引数 (`/model url http://...` 等) は使い方エラー、 一覧に無い名前は候補を示して拒否。 一覧が取れない (例外、 またはローカル系サーバー停止時の空一覧) ときも切り替えず、 再試行か `/model list` を案内する
- `/model second model <名前>` も同じ規則にした。 一覧取得に失敗したときの「直接指定: /model second model <名前>」 案内は、 直接指定も一覧を要するようになったため再試行の案内に直した
- `/loop`: 書き方を `/loop <間隔> <プロンプト>` の 1 つにした。 以前は間隔の省略時に既定 10m で登録しており `/loop list` が「list を 10 分ごとに送るループ」 になっていたため、
  先頭が間隔として読めない入力・プロンプトの無い入力 (`/loop 5m`) は登録せず使い方を出す。 ヘルプ・補完に無かった末尾 `every <間隔>` の別形式も削除した


## T3 実施内容 (2026-10-25)

### 削除したもの (互換 alias・「移動しました」 の案内 shim・削除名の特別扱いは無し)
- `/permission` の旧サブコマンド: `list` `rules` `rule-add` `rule-remove` `auto-add` `auto-remove` `require-add` `require-remove` `discord-add` `discord-remove`
  (`slack-add` / `slack-remove` は元々 dispatcher に無かった)。 補完のツール名補完 (`/permission auto-add <ツール名>` 用) も削除。
  引数付き `/permission` は「引数を取りません」 と表示して何もしない (どの引数も同じ扱い)
- 直接コマンド `/discord` `/slack` `/search` `/chatlog` (case 分岐ごと)。 補完・ヘルプには T1 時点で既に無かった。
  引数付き `/integrations` も「引数を取りません」 と表示する

### 対話画面の内部を関数呼び出しにした
- `/integrations` 画面は以前 `this.handleCommand("/discord <sub>")` 等で直接コマンドを呼んでいた。
  設定を書き換える処理を `src/cli/integrations-settings.ts` の関数 (setDiscordEnabled / setDiscordWebhookUrl / registerDiscordAsk / addDiscordUser /
  approveDiscordPending / setSlackBotToken / setChatlogVault / useSearxng / runSearchTest 等) に移し、 画面からはそれを直接呼ぶ。
  Discord 受信の開始/停止は REPL が持つ接続オブジェクトを扱うため repl.ts に残した
- `/permission` 画面は元々 PermissionManager を直接呼んでいたが、 config への反映と保存が画面内に重複していたため
  `src/cli/permission-settings.ts` (addPatternRule / removePatternRule / addToolToList / removeToolFromList / getToolList) にまとめた

### /integrations 画面に足したもの
- Discord「生成画像の自動添付をオン/オフにする」 (旧 `/discord images on|off` にしか無かった。 項目名に現在値を出す)
- Discord の状態表示に「受信の自動開始」 の行
- 直接コマンドにだけあった他の操作 (register / listen start・stop / test / トークン設定 / 待機リスト承認・却下 / chatlog vault 等) は画面に既にあった

### 廃止扱いにしたもの (画面に移さない)
- `/discord waitlist` (待機リストの一覧表示だけ): 画面の「待機リストから利用申請を承認する」 が同じ一覧を select で出すので不要
- `/discord approve <ID>` / `reject <ID>`: 同上 (select で選んで承認/却下)
- `/chatlog on|off` `/search ddg` の別名: 別名なので無し

### 非TTY
- `/permission` `/integrations` は stdin が端末でないとき、 対話端末が必要なことと、 代わりに `~/.localllm/config.json` で直接編集するキー
  (`security.rules.*` / `security.autoApproveTools` ほか、 `discord.*` / `slack.*` / `chatLog.*` / `search.*`) を表示して終わる。
  サブコマンドを非TTY 用に残すことはしていない

### 案内文
- 削除したコマンドを指していた案内を画面の項目名に直した: 起動時エラー (`--background` / `--slack` で必要な設定が無い時、 src/index.ts)、
  Discord 待機リストへの申請通知 (interaction-server.ts)、 Discord/Slack 経由で権限が無い時の拒否理由と永続許可時のメッセージ (permission-manager.ts)、
  画面内の「/integrations の Discord 連携メニューから設定」 等の文言、 コード中のセットアップ手順コメント
- 許可ユーザー未設定時の表示が「全員が利用可能」 になっていたが、 実際は fail-closed (誰も受け付けない) なので表示を直した
- docs: README・external_design・config-reference・slack-integration・chat-log・discord-gateway-design・channel-interaction-bridge-design・image-generation を
  画面の操作に直した。 integrations-command-cleanup.md は当時の記録として冒頭に追記のみ。 cycle-* と commit スキルのコミット例文 (履歴) は触らない

### 検査
- tests/cli/help-consistency.test.ts: 4 コマンドの case が無いこと、 `/permission` 旧サブコマンドの分岐が無いこと、 画面が削除コマンドを `handleCommand` で呼ばないこと
- tests/cli/integrations-settings.test.ts / permission-settings.test.ts: 画面が呼ぶ関数の動作と非TTY の案内文
- tests/cli/completer.test.ts: `/permission` は 1 件だけで旧サブコマンドのツール名補完が無いこと


## T4 実施内容 (2026-10-25)

### ルールの表し方 (security.rules だけ)
- 形は従来の `{ allow, deny, ask }` のまま。 ルール文字列の先頭に **面の指定** `cli:` / `discord:` / `slack:` を付けられるようにした (無ければすべての面)。
  別キー (面ごとの rules) にしなかったのは、 1 つの一覧で全部が見え、 既存のルール文字列の書き方 (`bash(npm *)`) をそのまま延長できるため
- allow は書き方で意味が決まる (新しい種類は足していない):
  - ツール名だけ (`file_read` / `bash`): ツール全体の許可 = 旧ツール名一覧と同じ扱い。 ask ルールより弱く、 安全確認が残る
    (サンドボックス外のパスは拒否、 bash の CWD 外参照・広域スキャンは確認、 autorun 中は autorun の判定が先)
  - 引数パターン付き (`bash(npm test)`): その形に限った明示許可。 確認なしで通す (ask より強い。 従来の allow ルールと同じ)
- 評価順 (CLI): deny → 引数パターン付き allow → ask → autorun / 封じ込め下の bash → 本質的に安全なツール・ツール名だけの allow・セッション許可 → 確認。
  旧コードの「パターンルール → autorun → ツール名一覧」 の順をそのまま保ち、 一覧の位置にツール名だけの allow が入った
- 評価順 (Discord / Slack): deny → サンドボックス → 引数パターン付き allow → ask (autorun を使わずブリッジ確認へ。 確認手段が無ければ拒否) →
  本質的に安全なツール・ツール名だけの allow・セッション許可 → autorun → ブリッジ確認。 その面に効くルールだけを見る
- 実装: `src/security/rule-engine.ts` (parseRule / formatRule / evaluateRules(…, surface) / isDeniedByRule / isToolAllowedByRule / allowRuleToolNames)、
  INHERENTLY_SAFE_TOOLS は `src/security/inherently-safe-tools.ts` に分けた (移行処理からも使うため)
- 既定ルール (getDefaultConfig): `allow: ["file_read", "glob", "grep", "browser_snapshot", "vision_analyze", "web_search", "web_fetch"]` (面の指定なし)。
  旧既定の 3 つの一覧から本質的に安全なツールを除くと同じ 7 つだったため
- 保存されたルールは既定ルールと混ぜない (旧一覧は「既定 ∪ 保存値」 だったため、 画面で既定ツールを外しても起動のたびに戻っていた)。 `security.rules` が無いときだけ既定

### requireApprovalTools の実際の意味 (コードで確認)
- 判定に使われていなかった: getPermissionLevel は autoApproveTools を先に見て auto を返し、 requireApprovalTools に当たっても返すのは既定と同じ ask。
  autorun・封じ込め下の bash 自動許可・Discord/Slack の判定も見ていない。 使われていたのは /permission 画面の表示だけ
- そのため対応するルールは作らない。 ask ルールにすると autorun や封じ込め下の bash 自動許可を止めてしまい判定が変わる (既定値 `["file_write", "file_edit", "bash", ...]` だと autorun が実質無効になる)

### 移行 (起動時に 1 回だけ。 `src/config/permission-migration.ts`、 loadConfig から呼ぶ)
旧キーがどれか 1 つでも config.json に残っていたら、 旧コードの判定 (一覧は「旧既定 ∪ 保存値」) を計算してルールに直し、 旧キーを消して保存する。
先に元のファイルを `config.json.before-rules-migration.bak` にコピーし (既にあれば時刻付きの別名。 権限は自ユーザーのみ)、 告知を 1 行出す。
バックアップに失敗したときは config.json を書き換えない (今回の起動だけ変換結果で判定し、 次回また試みる)。 2 回目以降は旧キーが無いので何もしない。

| 旧キー / 旧ルール | 新しいルール |
|---|---|
| `autoApproveTools` (CLI) のツール T | `cli:T` (allow、 ツール名だけ) |
| `discordAutoApproveTools` のツール T | `discord:T` |
| `slackAutoApproveTools` のツール T | `slack:T` |
| 上の 3 つすべてにあるツール T | `T` (面の指定なし) 1 本 |
| 本質的に安全なツール (ask_user / todo_* / current_datetime 等) | 書かない (どの面でも常に許可のため) |
| `requireApprovalTools` | なし (判定に未使用。 上記)。 告知で移さなかったことを伝える |
| autoApproveTools と requireApprovalTools の両方にあるツール | 旧コードでは autoApproveTools が勝つので `cli:T` |
| 既存 `rules.allow` / `rules.ask` の面の指定なしルール R | `cli:R` (旧コードは CLI でしか評価していなかった) |
| 既存 `rules.deny` | そのまま (旧コードもすべての面で強制) |

旧既定のままの config は `allow` が既定ルールと同じ 7 本になる。 旧キーは型・スキーマ・画面・案内文から削除し、 移行処理以外では読まない。

### 判定が変わるところ (旧コードの不整合。 意図的に直した)
- **既存の `rules.allow` に書かれていたツール名だけのルール** (例 `"bash"`): 旧コードでは確認なしで即許可 (サンドボックス外のパス・CWD 外参照も素通り、 ask ルールより強い) だった。
  同じツール名を autoApproveTools に入れた場合は安全確認が残っていたので、 同じ「ツール全体の許可」 が 2 通りの強さを持っていた。
  一本化後はツール全体の allow は常に安全確認つき・ask より弱い。 引数パターン付き (`bash(npm *)`) の allow は従来どおり即許可
- 画面で既定ルールを外すと外れたままになる (旧一覧は再起動で戻っていた)
- それ以外 (旧キーだけの config、 rules の deny / パターン付き allow / ask) は移行後も同じ判定になることをテストで確かめた

### 呼び出し側
- PermissionManager: 一覧用の API (getAutoApproveList / addAutoApprove / getDiscordAllowedToolNames 等) を削除し、 getAllowedToolNames(source) にした
- 確認ダイアログ 2 (セッション中常に許可) は従来どおり起動中だけ (設定は変えない)。 3 (設定に保存して常に許可) は allow ルール `cli:<ツール名>` を追加して保存
- /permission 画面: 範囲 (すべての面 / CLI / Discord / Slack) → 操作 (ツール全体を許可する [ツール picker] / 引数パターンで許可 / ask / deny / 削除)。
  関数は `src/cli/permission-settings.ts` (scopedRule / ruleScope / rulesForScope / addPatternRule / removePatternRule)
- 非TTY の案内、 Discord/Slack の拒否理由 (「/permission → Discord のルールで許可ルール "discord:bash" を追加」)、 /help・補完の説明を新しい書き方に直した
- docs: config-reference (「rules — 権限ルール」 を正本に)・external_design・slack-integration・README・image-generation・blender-mcp-integration、
  履歴の記述がある channel-interaction-bridge-design・security_assessment・async-surface-permission-delivery-design は注記を追加

### 検査
- tests/config/permission-migration.test.ts: 一覧だけ / rules だけ / 両方 (重なり・既存 allow・ask・deny) / 面ごとの一覧 / 不正な型 / loadConfig でのバックアップ・保存・告知 1 回・2 回目は何もしない / 既定ルールと混ぜない
- tests/security/permission-rules.test.ts: 面の指定の解釈、 CLI 既定・autorun・ツール全体の allow の安全確認・deny / ask の優先・パターン allow、 Discord/Slack の headless 許可/拒否、
  確認ダイアログ 2 / 3、 移行前後で判定が変わらないこと
- tests/cli/permission-settings.test.ts: 画面の関数 (範囲とルール文字列の対応・範囲ごとの一覧・追加/削除と保存)
- 既存の権限テストは同じ期待値のまま新しい表し方 (rules.allow) に書き換えた

