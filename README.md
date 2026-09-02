# LocalLLM Agent

ローカルLLMを使ったCLI型AIエージェント。Claude Codeにインスパイアされた、PC操作が可能な対話型アシスタント。

## 特徴

- **ローカルLLM対応**: Ollama, LM Studio, llama.cpp, vLLM をサポート
- **クラウドLLM対応**: Anthropic API 直接 / Claude Code CLI (`claude -p`) / Azure OpenAI / Azure Claude / Azure Anthropic / Azure Foundry / Vertex AI
- **豊富なツール群**: ファイル操作、コマンド実行、ブラウザ操作、Web検索をLLMが自律的に実行
- **セキュリティ**: Claude Code準拠の3段階権限モデル（自動許可/要確認/禁止）+ 50以上の危険コマンド検出パターン
- **サブエージェント**: タスク委譲による並列・バックグラウンド処理（explore / plan / general-purpose / bash）
- **プランモード**: 読み取り専用の計画フェーズで設計を固めてから実装
- **スキルシステム**: TDD、コミット、PRレビュー等のワークフローを `/commit` のように直接呼び出し
- **コンテキスト管理**: 80%消費時に自動圧縮（LLM自身による要約）
- **セッション管理**: 会話の保存・復元・継続・元を保持した分岐
- **永続メモリ**: セッションを跨いで知識を蓄積
- **画像認識**: Vision非対応LLM向けにサブLLM委譲をサポート
- **画像生成**: Azure GPT Images / Stable Diffusion WebUI / ComfyUI に対応（ON/OFF 可能、`/image` で設定・直接生成、`/cost` でコスト確認）
- **ブラウザ操作**: Playwright統合によるWeb自動化
- **Native Computer Use**: 明示opt-inしたlocal CLIから、選択したOS windowだけをcapture・click・入力（毎回確認、remote操作は禁止）
- **操作学習**: 成功したbrowser/computer操作を、秘密値を除いた手動起動skillとしてprojectへ保存
- **マルチライン入力**: Shift+Enter / Ctrl+J で改行、@path でファイル参照
- **処理中の追加入力**: 応答中に文字を入力して Enter すると、次の応答／tool完了境界で同じturnへ反映
- **LLM API境界pause**: 処理中に`/run pause`を予約し、進行中API完了後にrun全体を止めて、local LLMの再起動・並列数変更後に`/run resume`で継続
- **インタラクティブUI**: `/`コマンドと`@`ファイルパスの補完ドロップダウン
- **スキルベースワークフロー**: 開発・レビュー・調査等のワークフローをスキルとして定義、LLMが必要に応じて選択
- **ローカルplugin bundle**: 明示したbundleからskills・agents・hooks・MCPを一括ロード（Codex / Claude manifestの最小互換）
- **Safe mode**: `--safe-mode`でカスタマイズを一括停止し、壊れた設定から診断・復旧
- **フック・ルール**: ツール実行前後のフック、コーディングスタイル等のルール自動適用
- **クロスプラットフォーム**: Windows, macOS, Linux対応

## セットアップ

```bash
# インストール
npm install

# 初回設定（セットアップウィザード）
npm run setup

# 起動
npm start
```

### セットアップウィザードの流れ

1. LLMサーバーの種類を選択（Ollama / LM Studio / llama.cpp / vLLM）
2. サーバーのIPアドレスとポートを入力
3. 接続テスト → 利用可能モデル一覧を自動取得
4. モデルをリストから選択（手入力不要）
5. コンテキストウインドウサイズを設定（デフォルト: モデル上限）
6. 画像認識用サブLLMの設定（任意）

## 使い方

```
$ npm start

  LocalLLM Agent v0.4.1 (build abc1234)
  Model: qwen3.5:27b @ http://192.168.1.33:11434 (Ollama)
  Context: 130K tokens | Skills: 4
  CWD: /home/user/my-project
  Type /help for commands, /quit to exit.
  マルチライン: Shift+Enter / Ctrl+J (代替入力: ```)

> このディレクトリのファイルを見せて
  ✔ glob
  カレントディレクトリの内容: ...

> README.md を編集して、タイトルを変更して
  [file_edit] README.md を編集します。よろしいですか？ [y/N]
```

### 入力方法

| 操作 | 説明 |
|------|------|
| `Shift+Enter` | 改行を挿入（マルチライン入力） |
| `Ctrl+J` | 改行を挿入（Shift+Enter非対応ターミナル用） |
| ` ``` ` | マルチライン入力モード開始/終了（明示的な代替入力） |
| `@path` | ファイル/フォルダの内容をプロンプトに添付 |
| `/command` | スラッシュコマンド（補完ドロップダウン付き） |
| 応答中に文字 + `Enter` | 通常メッセージは次の応答／tool完了境界で現在のturnへ反映。`/run pause\|resume\|status`は即時、その他の`/command`はturn完了後に実行 |
| `/run pause` / `/run resume` | foreground runを進行中LLM APIの完了直後に一時停止 / 同じrunを再開（保存session復元の`/resume`とは別） |
| マウスホイール | Alternate Screen TUIの過去ログを上下する（LLM・ツール実行中も有効） |
| `PgUp` / `PgDn` | Alternate Screen TUIの過去ログをページ移動する（LLM・ツール実行中も有効） |
| `Ctrl+C` | 現在の操作をキャンセル |

端末本来のscrollback・選択・コピーを優先したい場合は、`npm start -- --no-alt-screen`
（配布版は`localllm --no-alt-screen`）でclassic stream表示として起動できます。
TTYの端末能力が不足または判定不能な場合、自動的に簡易表示へは切り替えず、原因と対処を表示して停止します。

### Native Computer Use（明示opt-in）

Playwrightのbrowser tab内操作とは別に、選択したOS windowのcapture・click・text入力・keyを行えます。Windows/Linux X11ではwheel scrollにも対応します。既定は無効です。

```bash
# このsessionだけ有効化
npm start -- --computer-use

# dependencyと可視window列挙だけを副作用なしで診断
node dist/index.js --check-computer-use
```

Windows、macOS、Linux X11に対応します。macOSは`cliclick`とAccessibility/Screen Recording権限、LinuxはX11、`xdotool`、ImageMagickが必要です。Waylandやdependency不足ではbrowser操作へ自動代替せず、復旧方法を表示して起動を停止します。

全`computer_*`操作はlocal CLI限定で、autorunや永続許可の設定に関係なく呼出しごとに確認します。Discord/Slackからのhost desktop操作と全画面captureは提供しません。詳細は[Native Computer Use設計](docs/native-computer-use.md)を参照してください。

### バージョンと更新診断

公開版は`MAJOR.MINOR.PATCH`の3桁、同じ公開版内の実体はGit commit由来のbuildで識別します。tracked変更を含む開発buildはcommitだけを名乗らず`-dirty`を付けます。

```bash
localllm --version
# localllm v0.4.1 (build abc1234)
# 開発中: localllm v0.4.1 (build abc1234-dirty)

# 最新release・tag・配布assetを明示確認（設定やsessionは作成しない）
localllm --check-update
localllm --check-update --json
```

`--check-update`は、ネットワーク不通、release tag不正、新版に配布assetが無い状態を成功扱いせず、理由と対処を表示してexit 1にします。自動置換は未署名・配布方式差を隠すため行いません。

### 操作学習（明示記録）

local CLIで、エージェントに実演させたbrowser/computer操作をproject-local skillへ変換できます。

```text
/learn start save-report browser レポート画面へ入力して保存する
> 対象画面を開き、入力して保存し、結果を確認して
/learn finish
/save-report
```

成功した対象tool callだけを順番に記録し、`.localllm/skills/<name>/SKILL.md`へatomicに保存します。入力文字列、URLのquery/fragment、screenshot保存先、一時window ID、tool出力は保存せずplaceholder化します。失敗または並列操作を含む実演はskill化せず、既存skillも上書きしません。

生成skillは`disable-model-invocation: true`の手動起動専用です。skillの存在は操作許可を意味せず、再生時も通常のpermission確認、現在DOMのselector再確認、`computer_windows`によるwindow再選択が必要です。Discord/Slackとworktree agentからの記録・保存は拒否します。任意の人間のmouse操作を画面録画する機能ではなく、エージェントが実行して成否を観測できるbrowser/computer tool軌跡を対象にします。詳細は[操作学習設計](docs/workflow-learning.md)を参照してください。

### Safe mode（カスタマイズ起因の故障診断）

```bash
npm start -- --safe-mode
```

`--safe-mode`は、その起動中だけplugin、skills、hooks、MCP、project指示、永続memory、
custom agents、user/project rulesを読み込みません。認証、model設定、built-in tools/agents/rules、
permission、sandboxは維持されるため、通常起動を壊すカスタマイズの切り分けと修正に使えます。
設定fileは変更・削除されず、次回の通常起動では元どおり読み込まれます。
`--plugin-dir`等を同時指定してもsafe modeが優先されます。

### コマンド一覧

| コマンド | 説明 |
|----------|------|
| `/help` | ヘルプ表示 |
| `/quit` `/exit` | 終了 |
| `/clear` | 会話履歴クリア（現在の Room） |
| `/room` | 会話 Room (A/B/C) の表示・移動・再開。`/room A\|B\|C` で移動、`/room resume [A\|B\|C]` で再開、`/room autoresume <on\|off> [A\|B\|C]`。既定 REPL=A / Discord=B / Slack=C（docs/room-model-design.md） |
| `/queue` | 受信順キューの待ち状況を表示（`/queue clear` でturn後に実行するtype-ahead command等を破棄） |
| `/run [status\|pause\|resume]` | foreground runの状態表示 / 次のLLM API境界で一時停止 / 再開。停止到達後は新しいmain LLM API・toolを開始しない（開始済みtool群は完了する場合あり）。background task・second LLMは対象外 |
| `/context` | コンテキスト使用状況の内訳（トークン数・進捗バー）。`/context <system\|memory\|skills\|tools\|messages>` で各カテゴリの中身をダンプ。`/context strategy [off\|auto\|aggressive]` で区切り整理のモード表示・切替（既定 auto、詳細: docs/context-strategy.md） |
| `/compact` | コンテキストを手動圧縮 |
| `/forget` | コンテキストを忘却で整理（要約せず捨てる）。`/forget dry` で何が消えるか事前確認、`/forget mode <compress\|forget\|hybrid>` で自動縮約の手段を切替（既定 hybrid）、`/forget status` で実績確認。詳細: docs/context-forgetting.md |
| `/handoff` | 引き継ぎメモを残してコンテキストをリセット。`/handoff dry` でメモを表示するだけ（リセットしない）。メモの生成に失敗した場合は履歴を変更しない。詳細: docs/context-strategy.md |
| `/model` | 現在のモデル情報 / `/model list` / `/model <name>` / `/model url <URL>` / `/model provider <type>` / `/model description <text>` / `/model temperature <値>` / `/model top_p <値>` / `/model top_k <値>` / `/model rep_penalty <値>` |
| `/second` | セカンドLLM管理 (status/enable/disable/setup/url/provider/model/context/description) |
| `/profiles` | LLM 接続プロファイル履歴 (`/profiles` で選択、`list` / `delete` / `help`)。 詳細: docs/llm-profiles.md |
| `/todo` | タスクリスト表示 |
| `/sessions` | 保存済みセッション一覧（直近10件） |
| `/resume <id>` | セッション復元 |
| `/continue` | 最新セッションを復元 |
| `/fork [id\|latest]` | 現在または保存済み会話を新しいセッションへ分岐（元セッションは不変） |
| `/rename <name>` | 現在のセッションへ名前を付け、`/resume list` と再開pickerへ保存 |
| `/memory` | 永続メモリ表示 |
| `/remember <text>` | メモリに追記 |
| `/diff` | stage済み・未stage・未追跡を含むworking treeの実Git差分を表示 |
| `/plan` | プランモードに入る |
| `/skills` | 利用可能なスキル一覧 |
| `/learn [status\|start\|finish\|cancel]` | browser/computer操作の明示記録を管理し、秘密値を除いた手動起動skillとして保存 |
| `/status` | 全体ステータス（モデル・コンテキスト・タスク等） |
| `/cost` | セッションのトークン使用量・コスト表示（画像生成コスト含む） |
| `/image` | 画像生成の設定・実行 (`on` / `off` / `setup <azure\|sd-webui\|comfyui>` / `set` (既定の品質・解像度のみ変更) / `use <name>` / `list` / `test` / `gen <prompt>`) |
| `/autorun` | Autorunモード切替（非破壊操作の自動許可） |
| `/doctor` | 環境診断 — LLM接続 / Playwright / Discord / Slack / 画像生成 / ディスク使用量を一括チェック。トラブル報告時はこの出力を添える |
| `/compress-input` | 入力圧縮モード切替（project指示/メモが閾値超過時に意図保持で圧縮、縮まなければ原文、既定OFF） |
| `/parallel` | 並列ツール実行数の設定 |
| `/second` | セカンドLLM委任の設定 |
| `/stream` | ストリーミング表示切替 |
| `/search` | Web検索 |
| `/permission` | 権限設定の管理 |
| `/loop` | 反復実行モード |
| `/goal-seek <goal>` | Goal Seek mode 開始（acceptance criteria を立て合格まで自律実行）。複雑なタスクは通常入力でも自動提案される（`goalSeek.autoPropose: false` で無効化） |
| `/exit-goal-seek` | Goal Seek mode を抜ける |
| `/integrations` | 外部サービス連携の設定メニュー (Discord / Slack / 会話ログ / Web検索)。Discord の `/ask` 受信は Gateway 方式で公開URL・トンネル不要 (docs/discord-gateway-design.md) |
| Discord/Slack からのコマンド | `/ask` の本文（Slack は通常メッセージ）を `/` で始めると、`/help` `/clear` `/context` `/status` `/todo` `/room` をリモート実行できる。意味は REPL と共通で、Discord は Room B / Slack は Room C に効く (docs/room-model-design.md §8) |
| `/discord` `/slack` `/chatlog` | [非推奨] 各サービスの単体設定コマンド。`/integrations` に集約済み (サブコマンド直打ちは動作維持) |
| `/knowledge` | Obsidianナレッジベース連携 (`save` / `search`) |
| `/try` | 実験的機能の実行 |

### スキル（直接呼び出し）

| コマンド | 説明 |
|----------|------|
| `/commit` | コミットワークフロー |
| `/pr-review` | PRコードレビュー |
| `/tdd` | テスト駆動開発（Red-Green-Refactor） |
| `/build-fix` | ビルドエラー修正 |
| `/code-review` | コードレビュー（重要度分類+修正案） |
| `/dev-workflow` | 開発ワークフロー戦略 |
| `/refactoring` | リファクタリング・機能廃止ワークフロー |
| `/research` | 調査・探索ワークフロー |
| `/project` | マルチファイルプロジェクト新規作成 |
| `/game-development` | ゲームアプリ実装 |
| `/business-book-writing` | ビジネス書執筆 |
| `/code-stats` | コードベース統計情報 |
| `/add-repl-command` | REPLコマンド追加ガイド |
| `/skill-creator` | スキル作成ガイド |

### ローカルplugin bundle

信頼したローカルdirectoryだけを、起動時に一つの拡張単位として読み込めます。自動探索はしません。

```text
quality-tools/
├── .localllm-plugin/plugin.json
├── skills/review/SKILL.md
├── agents/reviewer.md
├── hooks/hooks.json
└── .mcp.json
```

```json
{
  "name": "quality-tools",
  "version": "1.0.0",
  "skills": "./skills",
  "agents": "./agents",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}
```

一時利用は `npm start -- --plugin-dir ./plugins/quality-tools`、永続利用は
`~/.localllm/config.json` の `"pluginDirs": ["./plugins/quality-tools"]` で指定します。
`.codex-plugin/plugin.json` と `.claude-plugin/plugin.json` も上記fieldの範囲で読めます。
skillは `/quality-tools:review`、agentは `quality-tools:reviewer`、MCP serverは
`quality-tools__<server>` に名前空間化されます。`${PLUGIN_ROOT}` はhook/MCP設定とagent本文で
bundleの実pathへ展開されます。component pathはplugin root外へ出られず、同名pluginや曖昧な
複数manifestは起動前にエラーになります。JavaScript entrypointやremote marketplaceの自動実行・取得は行いません。
pluginのhookとstdio MCPはローカルcommandを実行できるため、内容を確認して信頼したbundleだけを指定してください。

## ツール一覧

LLMが自律的に呼び出すツール:

| ツール | 権限 | 説明 |
|--------|------|------|
| `file_read` | 自動 | ファイル読み取り（行番号付き、offset/limit対応） |
| `file_write` | 要確認 | ファイル作成・上書き（構文チェック付き） |
| `file_edit` | 要確認 | 文字列置換による部分編集 |
| `glob` | 自動 | パターンによるファイル検索 |
| `grep` | 自動 | 正規表現によるコンテンツ検索 |
| `bash` | 要確認 | シェルコマンド実行（120秒タイムアウト） |
| `web_search` | 自動 | Web検索（DuckDuckGo、APIキー不要） |
| `web_fetch` | 自動 | URL取得（HTML→テキスト変換） |
| `ask_user` | 自動 | ユーザーへの質問・選択肢提示 |
| `todo_write` | 自動 | タスクリスト管理 |
| `enter_plan_mode` | 自動 | プランモード開始 |
| `exit_plan_mode` | 自動 | プラン承認リクエスト |
| `task` | 自動 | サブエージェントへのタスク委譲（model / max turns / preload skills / `shared`・`worktree` isolation指定可） |
| `task_output` | 自動 | バックグラウンドタスクの結果取得 |
| `task_list` | 自動 | バックグラウンドタスクの実行中・完了・失敗・取消状態を一覧（prompt・結果本文は非表示） |
| `task_send` | 自動 | 実行中のバックグラウンドタスクへID指定で追加指示（本文は応答・一覧へ非表示） |
| `task_cancel` | 自動 | 実行中のバックグラウンドタスクをID指定で停止 |
| `task_diff` | 自動 | 保持中managed worktreeのstage/unstage/untracked/binary差分を取得 |
| `task_apply` | 要確認 | cleanかつ同一baseのmain checkoutへ隔離差分を適用 |
| `task_discard` | 要確認 | 保持中managed worktreeと未回収変更を明示破棄 |
| `schedule_create` | 自動 | 現REPL sessionに一回／反復プロンプトを登録（10秒〜7日、最大50件） |
| `schedule_list` | 自動 | 登録中scheduleと実行・skip・失敗状態を一覧 |
| `schedule_delete` | 自動 | scheduleをID指定または全件取消 |
| `skill` | 自動 | スキルテンプレートの実行 |
| `second_llm` | 自動 | セカンドLLMへのタスク委任 |
| `knowledge_save` | 自動 | Obsidianナレッジベースへの保存 |
| `knowledge_search` | 自動 | Obsidianナレッジベースの検索 |
| `current_datetime` | 自動 | 現在日時の取得 |
| `vision` | 自動 | 画像認識（マルチモーダル対応時） |
| `image_generate` | 自動 | 画像生成（`/image` で有効化時のみ。Azure GPT Images / SD WebUI / ComfyUI。設計: docs/image-generation.md） |
| `sandbox_info` | 自動 | サンドボックス情報の表示 |

### ブラウザツール（Playwright）

| ツール | 権限 | 説明 |
|--------|------|------|
| `browser_navigate` | 要確認 | URLを開く |
| `browser_snapshot` | 自動 | アクセシビリティツリー取得 |
| `browser_click` | 要確認 | 要素クリック |
| `browser_type` | 要確認 | テキスト入力 |
| `browser_screenshot` | 自動 | スクリーンショット取得 |
| `vision_analyze` | 自動 | 画像をVision LLMで分析 |

## サブエージェント

`task` ツールで専門的なサブエージェントにタスクを委譲:

| タイプ | 用途 | 使用可能ツール | 最大ターン |
|--------|------|----------------|-----------|
| `explore` | コードベース探索 | file_read, glob, grep | 20 |
| `plan` | 設計・計画 | file_read, glob, grep | 15 |
| `general-purpose` | 汎用タスク | 全ツール | 30 |
| `bash` | コマンド実行 | bash, file_read, glob, grep | 15 |

フォアグラウンド（完了まで待機）またはバックグラウンドで実行できます。バックグラウンドtaskは
`task_list`で状態を確認し、方針を変える場合は`task_send`で追加指示を送り、不要になった実行は
`task_cancel`で停止して、`task_output`で結果を取得します。追加指示はFIFOで処理され、進行中のLLM生成を
中断して新しいturnへ移ります。すでにtoolを実行中ならその1件の完了を待ち、同じturnの未実行toolをskipします。
指示は1件4000文字、待機中20件、sub-agent全体30 LLM turnが上限です。本文はtool応答や`task_list`へechoしません。
停止は進行中のLLM生成を中断し、新しいtool/iterationを開始しません。すでに実行中のtoolは戻った直後に停止します。
`task` の `skills` でその委任だけに必要なスキルを事前ロードできるほか、カスタムagent定義の
frontmatterへ `skills: [code-review, tdd]` と書けば毎回同じワークフローをsystem promptへ注入できます。
存在しない、または無効化中のskillは黙って省略せず、モデル起動前にエラーになります。

編集をmain checkoutから分離する場合は`task`へ`isolation: "worktree"`を指定するか、custom agentの
frontmatterへ`isolation: worktree`を指定します。agent定義で必須にした隔離を呼出側が`shared`へ降格することは
できません。変更なしworktreeは終了時に除去され、変更・取消・異常終了は`task_diff/apply/discard`または
`/tasks diff|apply|discard <agent-id>`で回収するまで保持されます。作成時にmainがdirty、適用時にbaseが進んだ、
Gitのhook/filterを安全に無効化できない場合はsharedへ代替せず理由付きで停止します。Native Windowsではfile toolを
隔離できますが、bashのfilesystem制約をOS強制できないためworktree bashは実行前に停止します。bashが必要な編集は
WSL2内で起動してください。

## モデル向けschedule

メインLLMは `schedule_create` / `schedule_list` / `schedule_delete` を使い、「10分後にCIを再確認」や
「1時間ごとにデプロイ状況を確認」のような将来turnを現REPL sessionへ登録できます。既定は一回限りで、
`recurring: true` のときだけ反復します。schedule自体はメモリ上の管理操作ですが、実行されたprompt内の
各toolは通常どおりpermission / sandboxを通ります。プロセス終了後まで残す永続schedulerではありません。

## プランモード

実装前に設計を固めるための読み取り専用フェーズ:

1. `/plan` またはLLMが `enter_plan_mode` を呼び出して開始
2. ファイル読み取り・検索のみ可能（書き込み不可）
3. 計画を `~/.localllm/plans/` に保存
4. `exit_plan_mode` でユーザーに承認を要求
5. 承認後、実装フェーズに移行

## アーキテクチャ

```
src/
├── index.ts                # エントリーポイント
├── cli/                    # REPL・インタラクティブUI
│   ├── repl.ts             # コマンドハンドラ・メインループ
│   ├── interactive-input.ts # マルチライン入力・補完ドロップダウン
│   ├── input-resolver.ts   # @ファイル参照の解決
│   ├── completer.ts        # コマンド・パス補完
│   └── renderer.ts         # ヘルプ・ウェルカム表示
├── config/                 # 設定管理
│   ├── config-manager.ts   # ~/.localllm/config.json 読み書き
│   ├── setup-wizard.ts     # 初回セットアップウィザード
│   └── types.ts            # 設定の型定義
├── providers/              # LLMプロバイダー（5種）
│   ├── base-provider.ts    # 共通インターフェース
│   ├── openai-compat.ts    # OpenAI互換API共通実装（SSE対応）
│   ├── ollama.ts           # Ollama（/api/tags, /api/show）
│   ├── lmstudio.ts         # LM Studio
│   ├── llamacpp.ts         # llama.cpp
│   ├── vllm.ts             # vLLM
│   ├── anthropic.ts        # Anthropic API (api.anthropic.com)
│   ├── claude-cli.ts       # Claude Code CLI (`claude -p`) ラッパー
│   ├── azure-*.ts          # Azure OpenAI / Claude / Anthropic / Foundry / GPT
│   ├── vertex-ai.ts        # GCP Vertex AI
│   └── provider-factory.ts # プロバイダー自動検出・生成
├── agent/                  # エージェントコア
│   ├── agent-loop.ts       # メインループ（最大50イテレーション）
│   ├── sub-agent.ts        # サブエージェント委譲
│   ├── message-history.ts  # 会話履歴管理
│   ├── context-manager.ts  # コンテキスト圧縮
│   ├── token-counter.ts    # トークン数推定
│   ├── session-manager.ts  # セッション保存・復元
│   ├── memory.ts           # 永続メモリ
│   ├── plan-mode.ts        # プランモード状態管理
│   └── system-prompt.ts    # システムプロンプト動的構築
├── tools/                  # ツールフレームワーク
│   ├── tool-registry.ts    # ツール登録
│   ├── tool-executor.ts    # 権限チェック・フック付き実行
│   └── definitions/        # ツール実装
├── agents/                 # サブエージェント定義
│   ├── agent-loader.ts     # Markdown定義の読み込み
│   └── builtin/            # 組み込みエージェント
├── skills/                 # スキル（ワークフローテンプレート）
│   ├── skill-registry.ts   # スキル登録・トリガー管理
│   ├── skill-loader.ts     # Markdown定義の読み込み
│   └── builtin/            # 14の組み込みスキル
├── rules/                  # ルールシステム
│   ├── rule-loader.ts      # 3ソースからの読み込み
│   └── builtin/            # coding-style, git-workflow, security
├── hooks/                  # フックシステム
│   └── hook-manager.ts     # PreToolUse / PostToolUse / Session
├── security/               # セキュリティ
│   ├── permission-manager.ts # 権限レベル管理
│   ├── sandbox.ts          # ファイルシステムサンドボックス
│   └── rules.ts            # 危険コマンド検出（50+パターン）
├── browser/                # Playwright統合
│   └── playwright-manager.ts
├── mcp/                    # MCP (Model Context Protocol)
│   ├── mcp-client.ts       # MCPプロトコルクライアント
│   └── mcp-manager.ts      # MCPサーバーライフサイクル
└── utils/                  # ユーティリティ
    ├── logger.ts           # ロギング
    ├── platform.ts         # OS検出・パス正規化
    └── http-client.ts      # HTTP通信
```

## セキュリティモデル

### 権限レベル

| レベル | ツール | 説明 |
|--------|--------|------|
| 自動許可 | file_read, glob, grep, web_search, web_fetch, ask_user, todo_write 等 | 読み取り・内部操作 |
| 要確認 | file_write, file_edit, bash, browser操作 | 変更を伴う操作 |
| 禁止 | サンドボックス外のファイル操作 | 安全性のため |

### サンドボックス

- カレントディレクトリ + `~/.localllm/` + 設定で指定したディレクトリのみアクセス可能
- シンボリックリンク解決による保護
- Windows パス正規化（8.3形式・UNCパス対応）

### OS レベル封じ込めで「安全に自走させる」 (`/sandbox`)

bash の実行を OS 機能でカーネルレベルに封じ込め、 その安全性を根拠に**確認を減らしてエージェントを自走させる**仕組み（macOS=sandbox-exec / Linux・WSL2=bubblewrap）。

```
/sandbox on              # 封じ込め有効化 (既定 fs: 書込は作業フォルダ・ネットは allowlist 経由)
/sandbox status          # レベル・ネット allowlist・自動許可・中継先を表示
/sandbox allow <domain>  # 通信を許可するドメインを追加 (例: /sandbox allow *.example.com)
/sandbox deny  <domain>  # allowlist から削除
/sandbox off             # 封じ込め解除
```

- **fs レベル**: 書込は作業フォルダ等に限定、 ネットは allowlist 経由のみ（npm/pip/GitHub は既定で許可）。未許可ドメインは初回に対話確認。
- **確認自動許可（macOS 先行）**: 封じ込め下では bash 実行確認を自動許可（破壊的コマンド・未許可ドメイン通信は引き続き確認）。`autoAllowBashWhenContained: false` でオプトアウト可。
- **機密保護**: `~/.ssh` `~/.aws` 等と**自アプリの API キー(`~/.localllm`)** はサンドボックス内 bash から読めない。
- 詳細・脅威モデルは [`docs/wsl-sandbox-design.md`](docs/wsl-sandbox-design.md)。Linux/WSL2 のネット allowlist 強制(2b-2)は実験的（WSL2 実機検証前）。

### 危険コマンド検出

50以上のパターンで破壊的コマンドを自動検出:
- 破壊的操作: `rm -rf /`, `mkfs`, `dd`, `format`
- システム: `shutdown`, `reboot`, フォーク爆弾
- 実行チェーン: `curl | bash`, `wget | sh`
- Git: `push --force` (main/master), `reset --hard`
- 認証情報漏洩: `echo $PASSWORD`, `export API_KEY`

## フック・ルール

### フック

ツール実行前後に自動処理を挿入:

| タイプ | タイミング |
|--------|-----------|
| `PreToolUse` | ツール実行前 |
| `PostToolUse` | ツール実行後 |
| `SessionStart` | セッション開始時 |
| `SessionStop` | セッション終了時 |

読み込み順: プロジェクト (`.claude/hooks.json` → `.localllm/hooks.json`) → ユーザーグローバル
(`~/.localllm/hooks.json`) → 明示plugin。すべてのmatching hookを順に実行します。

### ルール

Markdownファイルで定義するコーディング規約・ガイドライン:

- **coding-style** - コードフォーマット基準
- **git-workflow** - Git操作ガイドライン
- **security** - セキュリティプラクティス

読み込み優先順: 組み込み → ユーザーグローバル (`~/.localllm/rules/`) → プロジェクト (`.localllm/rules/`)

## 設定

設定ファイル: `~/.localllm/config.json`（初回は `npm run setup` で自動生成）

最小構成:
```json
{
  "mainLLM": {
    "providerType": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "qwen3:32b",
    "contextWindow": 40000
  },
  "visionLLM": null,
  "secondLLM": null,
  "security": {
    "allowedDirectories": [],
    "autoApproveTools": ["file_read", "glob", "grep"]
  },
  "context": {
    "compressionThreshold": 0.8
  }
}
```

サンプリングパラメータ（temperature, top_p, top_k 等）は未指定ならサーバー側のモデル推奨値がそのまま使われる。明示的に指定する場合は `mainLLM` 内に追加する。

### Claude をメイン/セカンドLLM として使う

| providerType | 認証 | 用途 |
|--------------|------|------|
| `anthropic`  | `ANTHROPIC_API_KEY` (env / 暗号化 / 平文) | Anthropic Messages API を直接叩く。 ツール呼び出し対応 |
| `claude-cli` | 不要 (`claude login` 済みの subscription を使う) | `claude -p` をサブプロセス起動。 ツールは Claude 内部で完結 (lllmAgents 側ツールには非接続) |

REPL での切替:

```
/model setup anthropic        Anthropic API (ANTHROPIC_API_KEY)
/model setup claude-cli       Claude Code CLI (claude -p)
/second setup anthropic       セカンドLLM として Anthropic API を設定
/second setup claude-cli      セカンドLLM として claude CLI を設定
```

選択可能モデル (`/model list` でハードコード一覧から選ぶ):

- `claude-opus-4-7` / `claude-opus-4-7[1m]`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`

全設定項目の詳細・用途別パターン例は **[docs/config-reference.md](docs/config-reference.md)** を参照。

### データディレクトリ

| パス | 内容 |
|------|------|
| `~/.localllm/config.json` | 設定ファイル |
| `~/.localllm/llm-profiles.json` | LLM 接続プロファイル履歴 (`/profiles` で管理) |
| `~/.localllm/sessions/` | セッション履歴 |
| `~/.localllm/memory/MEMORY.md` | 永続メモリ |
| `~/.localllm/plans/` | プランモードの計画書 |
| `~/.localllm/hooks/` | ユーザーグローバルフック |
| `~/.localllm/rules/` | ユーザーグローバルルール |
| `~/.localllm/llm-logs/` | LLM I/Oログ |

## テスト

```bash
# ユニットテスト実行
npm test

# E2E スモークテスト (モック LLM + 非TTYパイプモードでアプリ全体を起動)
npm run test:e2e

# ユニット + E2E をまとめて実行
npm run test:all

# ウォッチモード
npm run test:watch

# カバレッジ計測 (text サマリ + ./coverage/ に HTML レポート)
npm run test:coverage

# 型チェック + Biome (format 検査 / lint)
npm run lint

# コード整形 (Biome)
npm run format
```

## 必要環境

- Node.js 20+ （SEA ビルドのため。実行のみなら 18+ で動作するが、`build:exe` には 20 以上が必要）
- ローカルLLMサーバー（Ollama / LM Studio / llama.cpp / vLLM）
- Playwright（ブラウザ操作を使う場合）

## ライセンス

MIT
