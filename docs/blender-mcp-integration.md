# Blender MCP 連携

> **作成日**: 2026-05-03
> **改訂**: 2026-11-07 — 1 コマンドのセットアップ（`--install-blender` / `--check-blender`）とビルトインスキル `blender-modeling` を追加。サーバーの名前が `blender-mcp` → `mcp-for-blender` に変わったのに合わせた。

---

## 0. 結論

- アプリの MCP クライアント（`src/mcp/`）はそのまま使える。Blender MCP は `~/.localllm/mcp-servers.json` に 1 項目足せば道具が並ぶ。
- 新しい環境でも同じ状態にできるよう、**アドオンの導入・有効化と設定の登録を `localllm --install-blender` の 1 コマンドにした**（Playwright の `--install-browser` と同じ考え）。
- 形づくりの手順は **ビルトインスキル `blender-modeling`**（`src/skills/builtin/blender-modeling/`。Git で追跡し、`sync-skills.js` / 配布の `skills/` で `~/.localllm/skills/` に入る）。

### 2026-11 に分かったこと（馬を作らせて粗かった件）

1. `vision_analyze` が 3 回とも `model does not support image` で失敗していた（`visionLLM` 未設定・メインの LLM が画像を読めない）。**撮った絵を一度も見ずに直していた**。→ 画像を読めるモデルを `/model vision` で設定する（スキルにも「目が無ければそう報告する」と書いた）。
2. Windows の環境に `mcp-servers.json` が無く、MCP が無かった（前に使ったのは別の環境）。→ `--install-blender`。
3. 手順が無く、Skin モディファイアで棒をつないだ形を選んでいた（付け根が割れる）。→ スキルに部品箱 `bkit.py`・手順・見本・寸法の目安・様式の手引き・手本帳を入れた（§3）。

---

## 1. しくみ

| 項目 | 内容 |
|:---|:---|
| サーバー | `mcp-for-blender`（PyPI。旧名 `blender-mcp` は互換の殻）。`uvx` で起動する stdio の MCP サーバー |
| アドオン | 同じパッケージに同梱（`install-addon`）。Blender を開くと 9876 番で自動で待ち受ける（Auto-Start が既定で ON） |
| 通信 | localllm ⇄(stdio)⇄ サーバー ⇄(TCP 9876)⇄ Blender のアドオン |
| 版 | サーバーとアドオンの通信の版が合う必要があるので **版を固定**（`MCP_FOR_BLENDER_VERSION`。現行 2.2.7）。上げる時は定数を変えて `--install-blender` をやり直す |
| 道具（2.2.7） | `get_addon_status`・`get_scene_info`・`execute_blender_code`・`look`（画面を撮る）・`viewport_capture`・`search_assets`/`import_asset`/`generate_3d`（外のサービス）ほか。`mcp__blender__<道具>` で登録される |
| 絵 | MCP の画像は `renderMcpResult()` が一時ファイルに保存し、場所を返す → `vision_analyze` で見る |

---

## 2. セットアップ

### 2.1 前提

- Blender（4.2 以降を推奨。5.2 で確認）
- uv（`uvx`）
  - Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
  - macOS: `brew install uv`（または `curl -LsSf https://astral.sh/uv/install.sh | sh`）

### 2.2 `localllm --install-blender`（`src/blender/install-blender-mcp.ts`）

1. `uvx` を探す（PATH・`~/.local/bin`・`~/.cargo/bin`・macOS は Homebrew）。無ければ入れ方を表示して終わる。
2. Blender を探す（`LOCALLLM_BLENDER`・PATH・`Program Files\Blender Foundation\Blender*`・Steam・`/Applications/Blender*.app`・Linux の定番）。`--version` で版を読み、一番新しい物を使う。
3. `uvx mcp-for-blender@<版> install-addon --addons-dir <設定>/<版>/scripts/addons` でアドオンを置く。
4. Blender を画面無しで起動し、アドオンを有効にして設定を保存する。次の時は飛ばして手作業を案内する:
   - Blender が開いている（開いたままだと保存した設定が上書きされる）
   - その版をまだ一度も開いておらず、他の版がある（初回の「設定を引き継ぐか」の問いを消さないため）
5. `~/.localllm/mcp-servers.json` に `blender` を足す（他の項目は残す・前のファイルは `.bak`・読めない JSON は触らない）。
   既に `blender` があれば、利用者が決める `permissionLevel`・`disabled`・`env` の追加分は残す。

登録される項目:

```json
{
  "mcpServers": {
    "blender": {
      "name": "blender",
      "transport": "stdio",
      "command": "C:\\Users\\<you>\\.local\\bin\\uvx.exe",
      "args": ["mcp-for-blender@2.2.7"],
      "env": { "DISABLE_TELEMETRY": "true" },
      "permissionLevel": "ask"
    }
  }
}
```

- `command` は `uvx` の絶対パス（GUI やサービスから起動されて PATH が違っても動くように）。
- `permissionLevel: "ask"`: `execute_blender_code` は Blender の中で任意の Python を動かすので確認を出す。セッション中ずっと許すのは権限の確認で `2`。
- 戻り値: 0 = 全部済んだ / 1 = 手作業が残った（表示どおりにする）。

### 2.3 `localllm --check-blender`

uvx・Blender・`mcp-servers.json` の登録・9876 番の待ち受け を OK/NG で表示する（0 = 全部 OK）。

### 2.4 使い始める

1. Blender を開く（アドオンが自動で待ち受ける。止まっていたら N キーのサイドバー「MCP for Blender」で Start）。
2. localllm を起動（起動し直す）。`/mcp` で `blender` がつながっているか見られる。
3. 「Blender で〇〇を作って」→ スキル `blender-modeling` が使われる。

Blender を開く前に localllm を起動しても、サーバーはつながる（道具の呼び出しが失敗するだけ）。スキルは失敗したら Blender を開いてやり直すよう指示している。

---

## 3. スキル `blender-modeling`

方針: **手本の無い物でも作れる**ようにする。手本を増やすのではなく、どんな物も組める「部品箱」と、「調べる → 部品に分ける → 寸法の表 → 組む → 撮る → 比べる」の手順を渡す。
うまくできた物はエージェント自身が「手本帳」に残し、次の出発点にする（使うほど作れる物が増える）。

| ファイル | 中身 |
|:---|:---|
| `SKILL.md` | 最初の確かめ（MCP・目・出力先・手本帳・様式）／調べて部品に分ける（形の種類 → 道具の表）／やってはいけないこと／座標の決まり／作って確かめる・見る時の問い／様式（ローポリ・ボクセル・トゥーン・デフォルメは頼まれた時だけ）／MCP と画面無し／報告 |
| `references/bkit.py` | 部品箱: `loft`（断面の並び）・`fuse`（継ぎ目を溶かして 1 枚の皮。Remesh＋Corrective Smooth×2。見た目はなめらか）・`paint_by_parts`・`box`・`cylinder`・`sphere`・`prism`（XZ/YZ/XY の押し出し）・`hull`（船体・車体）・`gable_roof`/`shed_roof`（屋根。傾ける向きの計算を中に持つ）・`cut`・`mirror_x`・`repeat`・`join`・`blob`・`tube`・`flatten_bottom`・`decimate`・`lowpoly`・`voxelize`（格子の内外を調べて積み木を置く・色を引き継ぐ）・`measure`・`render_views`・`export` |
| `references/examples/` | 見本: `creatures.py`（馬・人）・`objects.py`（机・剣・家・車・船・江戸の町家）・`nature.py`（岩・木） |
| `references/proportions.md` | 寸法の目安（人・動物・家具・道具・乗り物・建物）。無い物は `web_search` で調べる |
| `references/styles.md` | 様式の見分けどころ（江戸の町家・農家・武家屋敷・明治の洋館・昭和・今の住宅・ファンタジー・和と洋の城・乗り物）と bkit での作り方 |
| `references/library.md` | 手本帳の決まり（作業フォルダの `blender-library/`〔Git に残せる〕か `~/.localllm/blender-library/`。`INDEX.md`・`build.py`・`notes.md`・絵） |

手本は MCP（`execute_blender_code` で bkit を `exec` してから呼ぶ）でも画面無し（`blender -b --python examples/<file>.py -- <出力> <種類>`）でも動く。

### 動作確認（2026-11-07・Windows 11・Blender 5.2.3）

- 見本 10 個（机・剣・家・車・船・町家・馬・人・岩・木）を画面無しで実行し、全部の絵を目で確認。`measure` の寸法は表どおり（人 1.72m・馬 体高 1.6m／全高 2.05m・車 4.5 × 1.8 × 1.46m など）。
- 手本の無い物の試し: 江戸の町家を bkit だけで組んだ（格子・のれん・虫籠窓・庇・瓦の切妻）。最初は屋根の板を自分で傾けて符号を間違えた → `gable_roof`/`shed_roof` を足し、スキルに「板を自分で傾けない」と書いた。
- 直したこと: 細い手足が波打つ（Laplacian）→ Corrective Smooth。Remesh の Blocks でボクセルにすると脚が切れる → 自前の `voxelize`。髪が額にかかる → 断面を後ろへ。
- 見た目は「なめらかで形は読める」段階（顔・指は無い）。細部は利用者の頼みに応じてエージェントが足す。

---

## 4. セキュリティ

- `execute_blender_code` は Blender の中で任意の Python を動かす（サンドボックス無し）。既定は `ask`。`auto` にするのは信頼できる環境だけ。
- `generate_3d`・`import_asset` は外のサービス（有料・ライセンスあり）。スキルで「ユーザーが許した時だけ」と縛っている。
- サーバーの送信（テレメトリ）は `DISABLE_TELEMETRY=true` で止める。アドオン側の送信は既定で OFF（設定で同意した時だけ）。

---

## 5. トラブルシューティング

| 症状 | 対処 |
|:---|:---|
| `uvx が見つかりません` | §2.1 で uv を入れ、新しいターミナルで `--install-blender` |
| `Blender が見つかりませんでした` | `LOCALLLM_BLENDER` に実行ファイルの場所を入れてやり直す（Steam を別ドライブに入れた時など） |
| `Blender が開いているので…` | Blender を閉じてやり直すか、プリファレンス → アドオン → 「MCP for Blender」に印 |
| 道具の呼び出しが connection refused | Blender が開いていない／待ち受けが止まっている。`--check-blender` の 9876 番を見る |
| `MCP: blender 接続失敗` | `uvx mcp-for-blender@2.2.7 --help` が手で動くか（初回は取得に時間がかかる） |
| 撮った絵を見られない | `/model vision` で画像を読めるモデルを設定（`model does not support image`） |

---

## 6. テスト

- `tests/blender/install-blender-mcp.test.ts`: uvx・Blender の探し方（Windows/macOS/Linux）、版の読み取りと選び方、設定の置き場所、初回の版で設定を保存しない判断、`mcp-servers.json` の書き足し（他を残す・旧設定の置き換え・2 回目は変わらない・壊れた JSON を触らない）、有効化の結果の読み取り。
- `tests/skills/blender-modeling-skill.test.ts`: スキルを読み込める・リンク先がある・SKILL.md の挙げる関数と見本が使う関数が bkit.py にある。
- 実機: §3 の動作確認。`--install-blender` の実機実行は未確認（外からパッケージを取る操作のため利用者が実行）。
