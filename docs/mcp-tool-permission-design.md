# MCP ツールの権限 (サーバーの設定・注釈・中身の検査器)

> **作成日**: 2026-11-08
> 実装: `src/security/mcp-tool-policy.ts`・`src/security/blender-code-inspector.ts`・`src/mcp/mcp-manager.ts`・`src/security/permission-manager.ts`
> テスト: `tests/security/mcp-tool-permission.test.ts`・`tests/mcp/mcp-manager.test.ts`・`tests/blender/install-blender-mcp.test.ts`

---

## 0. 背景

自律実行モード (autorun) でも `mcp__blender__execute_blender_code` を呼ぶたびに確認が出ていた。原因:

1. `checkAutorunPermission` が自動で許すのは組み込みのツール (file_write・bash・browser_*・web_*・読み取り系・game_smoke) だけで、
   MCP ツール (`mcp__<サーバー>__<ツール>`) は必ず「未知のツール → 通常の流れ」 → 確認になる。
2. 「許可 (今回のみ)」 は引数のハッシュで覚えるので、 毎回コードが違う `execute_blender_code` には効かない。
3. `mcp-servers.json` の `permissionLevel` (`--install-blender` と Unity 連携が書く) を権限の判定がどこでも読んでいなかった (死んだ設定)。
4. MCP 標準のツールの注釈 (`readOnlyHint`・`destructiveHint`) を取り込んでいなかった。ただし使っている
   `mcp-for-blender@2.2.7` は注釈を付けないので、 注釈だけでは Blender は直らない。

そこで、 どの MCP サーバーにも使える仕組み (層 1・層 2) と、 ツールごとに差し込める中身の検査器 (層 3) を足した。

## 1. 3 つの層

| 層 | 何を見るか | 結果 |
|:--|:--|:--|
| 3. 中身の検査器 | ツールの値が `"inspect"` のとき、 そのツールに登録された検査器が引数を見る | 引っかかれば確認 (理由つき)。 通れば自律実行モードの間だけ自動許可 (通常モードは従来どおり確認)。 検査器が無ければ確認 |
| 1. 設定 | `mcp-servers.json` の `permissionLevel` (サーバー全体) と `tools` (ツールごと。 サーバー全体より勝つ) | `"auto"` = 常に自動許可・`"autorun"` = 自律実行モードの間だけ自動許可・`"ask"` = 確認 (従来どおり) |
| 2. 注釈 | 設定が無いツールだけ。 `tools/list` の `annotations` | 自律実行モードの間 `readOnlyHint: true` は自動許可。 `destructiveHint: true` は確認 |

- サーバー全体の `"auto"`/`"autorun"` は、 `destructiveHint: true` のツールには広げない (確認)。 ツールごとに `"auto"` 等を書けば広がる。
- `"ask"` は明示の確認なので、 注釈 (`readOnlyHint`) でも自動許可しない。 注釈を効かせたいサーバーは `permissionLevel` を書かない。
- 注釈・検査器はどれも見当 (サーバーの自己申告・文字の並びの検査)。 「自動許可 = 安全の保証」 ではなく、 確認の回数を減らすための物。

## 2. 設定 (`mcp-servers.json`)

```json
{
  "mcpServers": {
    "blender": {
      "transport": "stdio",
      "command": "C:\\Users\\<you>\\.local\\bin\\uvx.exe",
      "args": ["mcp-for-blender@2.2.7"],
      "permissionLevel": "autorun",
      "tools": { "execute_blender_code": "inspect", "get_scene_info": "auto" }
    }
  }
}
```

| 項目 | 値 | 既定 |
|:--|:--|:--|
| `permissionLevel` | `"ask"`・`"auto"`・`"autorun"` | 無し (= 注釈で判定し、 それ以外は確認) |
| `tools.<サーバー側のツール名>` | `"ask"`・`"auto"`・`"autorun"`・`"inspect"` | 無し (= `permissionLevel` に従う) |

- 知らない値は黙って読み替えず、 起動時に警告して `"ask"` として扱う (自動許可に倒さない)。
- plugin が持ち込む MCP サーバー (`.mcp.json`) は、 自分の道具に自動許可を与えられない: `permissionLevel`・`tools` は `"ask"` だけ読む。 自動で許すのは利用者の allow ルール (`cli:mcp__<plugin>__<server>__<tool>`)。
- 設定を変えたら `/mcp reload` か起動し直しで効く (ツールを登録するときに読む)。
- `--install-blender` は新しく入れるとき `permissionLevel: "autorun"`・`tools: { "execute_blender_code": "inspect" }` を書く。 入れ直しでは利用者の `permissionLevel`・`tools` を残す。
- Unity 連携 (plugin) は `"ask"` のまま (Unity の道具はシーンを書き換えるので確認を既定にする)。

## 3. 判定の順番

### CLI (`checkCliPermission`)

1. deny ルール → 拒否 (従来どおり)
2. 危険コマンドの block (bash のみ)
3. `INHERENTLY_SAFE_TOOLS` → 許可
4. CoT 不整合のターン → 確認 (MCP の決まりは使わない)
5. 引数パターン付き allow ルール → 許可
6. **MCP の決まり (層 3 → 層 1 → 層 2)**: 許可ならここで許可。 ask ルールに一致したときは自動許可に使わない。 確認なら理由を覚えて次へ
7. 自律実行モード / 封じ込め (組み込みのツール。 MCP は対象外)
8. ツール名だけの allow ルール・セッション中常に許可 → 許可 (MCP の決まりが確認と言っても勝つ = 明示の許可は従来どおり)
9. 「今回のみ」 の承認 → 確認ダイアログ (選択肢は従来の 5 つのまま。 MCP の理由は `⚠ 確認する理由: …` で出す)

### Discord / Slack (`checkChannelPermission`)

deny ルール → サンドボックス → 危険コマンド → `INHERENTLY_SAFE_TOOLS` → 引数パターン付き allow → (ask ルール・CoT 不整合でなければ) ツール名だけの allow・セッション許可 → 「今回のみ」 → **MCP の決まり** (autorun はその面の `discordAutorun`/`slackAutorun`) → 面の autorun (MCP は対象外なので理由つきで拒否) / ブリッジ確認 (確認の文に理由を出す)。

## 4. Blender の検査器 (`execute_blender_code` の `code`)

登録: `registerMcpContentInspector({ tool: "execute_blender_code" }, …)` (サーバー名を変えても効くよう、 ツール名だけで引く)。
文字の並びを見る控えめな見当で、 分からない物は確認に回す。 コメント (`#` から行末) は見ない。

**通す物**

- `import` してよいモジュール: `bpy`・`bmesh`・`bpy_extras`・`mathutils` (`mathutils.bvhtree` 等)・`math`・`random`・`colorsys`・`itertools`・`functools`・`collections`・`json`・`re`・`time`・`datetime`・`typing`・`dataclasses`・`copy`・`enum`・`statistics`・`numpy` など純粋な計算の物
- `os` は `os.path.*`・`os.makedirs`・`os.mkdir`・`os.sep`・`os.listdir` などだけ。 `sys` は `sys.path`・`sys.version`・`sys.platform`・`sys.stdout` などだけ (sys.path を足しても、 許していないモジュールの import は確認になるので害が無い)
- 部品箱の読み込み `exec(open(r"<~/.localllm/skills の下の .py>", encoding="utf-8").read(), globals())` (スキル `blender-modeling` の決まった形。 作業フォルダの .py は agent が書けるので許さない)
- 作業フォルダの中の絶対パスへの保存・書き出し・撮影 (`bpy.ops.wm.save_as_mainfile(filepath=…)`・`bpy.ops.export_*`・`bpy.ops.wm.*_export`・`image.save_render`・`render.filepath = …` と `render(write_still=True)`・bkit の `render_views`/`export`・`os.makedirs`)。
  行き先が変数でも、 コードに作業フォルダの絶対パスが書かれていて、 コードの外の場所 (ホーム・Blender のファイルの場所・一時フォルダ・Blender の cwd) を使っていなければ通す

**確認に回す物** (確認の画面に理由を出す)

| 種類 | 例 |
|:--|:--|
| 許していないモジュール | `subprocess`・`shutil`・`socket`・`urllib`・`requests`・`http`・`ctypes`・`tempfile`・`importlib`・`addon_utils` ほか一覧に無い物すべて |
| os / sys の危ない名前・別名 | `os.remove`・`os.unlink`・`os.system`・`os.environ`・`os.rename` …・`sys.modules`・`sys.exit` …・`import os as o` |
| コードを組み立てて動かす | `eval`・`exec` (部品箱の形を除く)・`compile`・`__import__`・`__builtins__`・`__subclasses__`・`globals()[…]`・`getattr(os, …)` |
| ファイル | `open()` の相手が作業フォルダの中の絶対パスの文字列でない (読みも)・`open(…, "w"/"a")` で外に書く・`pathlib` の `write_text`/`unlink`/`rename` 等 |
| パス | 作業フォルダの外の絶対パス (`C:\…`・`C:/…`・`\\server\…`・`/etc/…`・`~/…`)・書き出し先が無い (`save_mainfile()` = 開いているファイルの上書き)・相対パス (Blender の cwd で決まる)・`//` (Blender のファイルからの相対)・書き出し先を `bpy.data.filepath`/`expanduser`/`getcwd` 等から作る・`render(write_still=True)` なのに `filepath` をこのコードで決めていない |
| Blender の外側 | `bpy.ops.wm.quit_blender`・`save_userpref`・`bpy.ops.preferences.*` (アドオンの導入・有効化)・`bpy.ops.script.*`・`bpy.ops.text.run_script`・`.as_module()`・`bpy.utils.register_*`/`execfile`・`bpy.app.handlers`/`timers`・`use_scripts_auto_execute`・`bpy.ops.wm.open_mainfile`/`read_homefile`/`read_factory_settings`/`url_open`・`bpy.ops.file.*` |

文字列の中の文字もそのまま見るので、 `print("os.remove")` のような物も確認になる (安全側の誤り)。

## 5. 確かめたこと・残り

- 単体テスト: 層ごとの値 (autorun の入り切り)・ツールごとの上書き・注釈・検査器の通す例 (典型の形づくり・作業フォルダへの撮影) と確認の例・順番 (deny が auto に勝つ・ask ルールが検査器の allow に勝つ・名前だけの allow が検査器の ask に勝つ・CoT 不整合)・Discord/Slack・MCPManager の登録と plugin の扱い・インストーラの既定と引き継ぎ。
- 未確認: 起動中の Blender (実機の `mcp-for-blender`) に対する通し。 検査器が通すかどうかの判定はテストで見たが、 実際のスキルの実行で確認がどれだけ減るかは見ていない。
