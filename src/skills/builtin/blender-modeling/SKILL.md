---
name: blender-modeling
description: Blender で 3D モデル（動物・人・キャラクター・小物・建物）を作る・直すスキル。「Blender で馬を作って」「3D モデルを作って」「FBX が欲しい」など、Blender を使う形づくりを頼まれたときに使う。Blender MCP（mcp__blender__*）があれば起動中の Blender を操作し、無ければ blender -b --python で作る。
---

# Blender Modeling Skill

形は「数値の表 → 作る → 撮る → 見て比べる → 表を直す」の繰り返しで良くする。一度で良い形は出ない。
**撮った絵を見ずに「できた」と言わない。**

## 0. 最初に確かめる（毎回）

1. **道具**: `mcp__blender__*` の道具があるか。
   - ある → 「MCP で進める」（§4）。最初に `mcp__blender__get_addon_status` と `mcp__blender__get_scene_info`。
   - 接続できない（connection refused・Blender が応答しない）→ Blender が開いていない。開いて 15 秒待ってからやり直す:
     - Windows: `start "" "<blender.exe の場所>"`（よくある場所: `C:\Program Files\Blender Foundation\Blender <版>\blender.exe`、`C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe`）
     - macOS: `open -a Blender`
   - 道具が無い → 「画面無しで進める」（§5）。報告の最後に「`localllm --install-blender` を実行して起動し直すと、起動中の Blender を直接操作できる」と伝える。
2. **目**: 小さな絵を 1 枚撮って `vision_analyze` で見る。
   - `model does not support image` などで失敗したら、**形の良し悪しを判断できない**。作業は続けてよいが、ユーザーに「画像を読めるモデルを `/model vision` で設定してほしい」と伝え、報告では「目で確かめていない」と書く。数値の確かめ（§3 の手順 5）は必ずやる。
3. **出力先**: ユーザーが言った作業フォルダ（無ければ聞く）。絵・`.blend`・`.fbx`・作るスクリプトを同じフォルダに置く。

## 1. やってはいけないこと（前に失敗した形）

- **生き物の体を Skin モディファイアや円柱・球の寄せ集めで作らない**。棒をつないだ形になり、付け根が割れる・めり込む。→ 断面の並び（loft）＋ボクセルで一体にする（§3）。
- 部位を別々の物のまま重ねて終わらない（付け根に割れ目が出る）。必ず一体にする。
- 寸法を当て推量しない。先に表を書く（[references/proportions.md](references/proportions.md)）。
- 長い 1 本のスクリプトを一度に書かない。作る → 撮る → 直すを小さく回す。
- ノードを名前で探さない（言語で名前が変わる）。`n.type == "BSDF_PRINCIPLED"` のように型で探す。
- `generate_3d`・`import_asset`・`search_assets`（外のサービス・有料・ライセンスあり）は、ユーザーが許した時だけ使う。
- Blender の版で API が違う。分からない所は小さなスクリプトで確かめてから使う（`bpy.app.version` を表示する）。

## 2. 座標の決まり

- 単位は m。上 = +Z、地面は z=0（足の裏・ひづめの底を 0 にそろえる）。
- 生き物は **前 = -Y、右 = +X**。左右対称の部位は片側を書いて X を反転して作る。
- 書き出す先（Unity など）の決まりがあれば合わせる（FBX は `axis_forward="-Z", axis_up="Y"` が Unity 向けの定番）。

## 3. 生き物の作り方（手順）

**手本**: [references/organic_loft.py](references/organic_loft.py)（Blender 4.2〜5.x で動く。馬の形が入っている）。これをコピーして作業フォルダに置き、表（`PARTS`）だけ書き換える。

1. **寸法の表を書く**: [references/proportions.md](references/proportions.md) から、体高・体長・頭・首・脚の関節の高さを m で書き出す。
2. **断面の並びにする**: 部位ごとに `(x, y, z, 幅の半分, 高さの半分)` を道すじに沿って並べる。
   - 胴・首・頭: 「高さの半分」は上下。脚: 「高さの半分」は前後の厚み。
   - 関節（ひじ・ひざ・飛節・球節）は前後の断面より少し太く、その間（管・すね）は細くする。これで「関節のある脚」に見える。
   - **付け根の断面は胴の中に深く入れる**（脚の 1 番目・首の 1 番目は胴の中）。外に出ると折れ目が残る。
3. **一体にする**: `fuse()`（ボクセルで作り直す → ならすを 2 回）。`VOXEL` は体長の 1/150〜1/200。
4. **撮る**: `render_views()` が 横・前・後ろ・上・斜め を撮る（Workbench・速い）。
5. **数値で確かめる**（目が無くてもできる）: 一番下の z が 0 か、体高・体長・幅が表と 5% 以内か、を頂点から測って表示する。
   ```python
   import bpy
   ob = bpy.data.objects["Horse"]
   vs = [ob.matrix_world @ v.co for v in ob.data.vertices]
   print("min z", min(v.z for v in vs), "max z", max(v.z for v in vs))
   print("length y", max(v.y for v in vs) - min(v.y for v in vs), "width x", max(v.x for v in vs) - min(v.x for v in vs))
   ```
6. **見て比べる**: 絵ごとに `vision_analyze` で具体的に聞く（下の「見る時の問い」）。答えから **表の数値**を直して 3 に戻る。
7. 5 回直しても良くならない所は、残った問題として報告に書く（ごまかさない）。
8. **細部**: 形が決まってから。目（小さな球を少し埋める）・鼻の穴・ひづめの色・たてがみ・尾。色は部位ごと（手本の `paint_by_parts`）。
9. **書き出す**: `.blend`・`.fbx`・確かめの絵 5 枚・面の数。ゲームに使うなら `TARGET_FACES` で面を減らす（目安: 小物 2 千・動物 1〜3 万）。

### 見る時の問い（vision_analyze の prompt）

一度に全部を聞かず、絵 1 枚に 3 つまで。「良いですか」ではなく、場所を挙げて聞く。

- 横: 「(1) 背の線（き甲→背→腰→尻）がなめらかか、へこみ・段差はどこか (2) 前脚と後ろ脚の関節の位置と曲がる向き（前ひざは前・飛節は後ろ）(3) 首の太さと角度、頭の長さは胴に比べて自然か」
- 前・後ろ: 「(1) 左右の脚がまっすぐ立っているか、開き・寄りはどうか (2) 胴の幅は前と後ろで自然か」
- 斜め: 「(1) 付け根に割れ目・めり込み・折れ目が見えるか、どこか (2) 浮いている部品はあるか」

## 4. MCP で進める（起動中の Blender）

- コードは `mcp__blender__execute_blender_code` に**小分けにして**渡す（部位を作る・一体にする・色・撮る を別々に）。手本の関数は最初に 1 回送って定義しておくと、あとは呼ぶだけで済む。
- 見るのは `mcp__blender__look`（画面を撮る）。返った絵は一時ファイルに保存されるので、その場所を `vision_analyze` に渡す。
- 区切りごとに保存する: `bpy.ops.wm.save_as_mainfile(filepath=r"<作業フォルダ>\<名前>.blend")`。
- ユーザーの開いている場面を消す前に確かめる（新しい物を作るなら新しい場面か、`get_scene_info` で中身を見てから）。

## 5. 画面無しで進める（MCP が無い時）

- スクリプトを作業フォルダに書き、`"<blender.exe>" -b --python <スクリプト> -- <出力フォルダ>` で動かす。
- 手本はそのまま動く（引数の出力フォルダに絵・`.blend`・`.fbx` を書く）。
- 失敗したら出力の `Traceback` と `Error` の行だけを読んで直す（全文を読まない）。

## 6. 報告

- 作った物の場所（`.blend`・`.fbx`・絵）、面の数、寸法（体高・体長）。
- **確かめたこと**と**確かめていないこと**を分けて書く（絵を見られなかったら、そう書く）。
- 残った問題と、次に直すならどこか。
