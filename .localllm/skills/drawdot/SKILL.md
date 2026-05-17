---
name: drawdot
description: ドット絵キャンバスを作成・編集するときに使う。8/16/32/64/128px の正方ピクセルアートを MCP ツール drawdot と vision_analyze を組み合わせて反復改善する。
tools: [vision_analyze]
---

# drawDot Skill — 創造的反復

## 原則
- 考え込みすぎず **まず大ざっぱに何か描き出す** (rect.fill でも dot でも自由)
- **描いたら必ず inspect_canvas を呼んで canvas の現状を確認**
- 確認した結果を基に **次に何をするか自分で決める** (todo を append / mark)
- 「描く → 確認 → 決める」 のリズムを短く保つ。 head の中で全画像を構築しない

## 流れ (順序・粒度は自由)
1. todo_append で **粗い戦略** をコミット (詳細は決めなくて良い)
2. 何か描き出す (自分が「ここから」 と感じた所から)
3. inspect_canvas で canvas の現状を確認
4. 次にやることを判断 (todo を append / mark で更新)
5. 上を繰り返す
6. 一通り形になったら start_refinement_session で Vision 評価

## 利用ツール
- `mcp__drawdot__create_canvas` — 8/16/32/64/128px の正方キャンバス新規作成
- `mcp__drawdot__apply_commands` — 描画コマンド適用 (下の op 一覧を参照)
- `mcp__drawdot__inspect_canvas` — 現状取得 (width/height/pngPath/palette/nonTransparentPixels)
- `mcp__drawdot__start_refinement_session` / `get_refinement_prompt` / `refine_with_feedback` / `get_refinement_status` / `finalize_refinement` — 反復改善セッション
- `vision_analyze` — refinement_prompt と inspect.pngPath を渡して評価

パスは絶対パスのみ。 背景は `create_canvas` の `background` で `"transparent"` (default) か `"#rrggbb"` hex を指定。

## apply_commands の op 別引数
op ごとに必要なフィールドが違う。 不要なフィールドは渡さない。 color は省略可 (palette.primary を使う)。

| op | 必須 | 任意 | 例 |
|---|---|---|---|
| `dot` | `x`, `y` (int) | `color` / `slot` | `{"op":"dot","x":5,"y":7,"color":"#ff8800"}` |
| `line` | `x1`, `y1`, `x2`, `y2` (int) ← **`x/y` ではなく `x1/y1`** | `color` / `slot` / `thickness` | `{"op":"line","x1":0,"y1":0,"x2":10,"y2":5,"color":"#000","thickness":2}` |
| `rect` | `x`, `y`, `w`, `h` (int, w/h≥1) | `color` / `slot` | `{"op":"rect","x":2,"y":2,"w":4,"h":3,"color":"#00ff00"}` |
| `rect.fill` | `x`, `y`, `w`, `h` (int, w/h≥1) | `color` / `slot` | `{"op":"rect.fill","x":2,"y":2,"w":4,"h":3,"color":"#00ff00"}` |
| `circle` | `cx`, `cy`, `r` (int, r≥1) | `color` / `slot` / `thickness` | `{"op":"circle","cx":16,"cy":16,"r":6,"color":"#0044ff"}` |
| `circle.fill` | `cx`, `cy`, `r` (int, r≥1) | `color` / `slot` | `{"op":"circle.fill","cx":16,"cy":16,"r":6,"color":"#0044ff"}` |
| `ellipse` | `cx`, `cy`, `rx`, `ry` (int, ≥1) | `color` / `slot` / `thickness` | `{"op":"ellipse","cx":16,"cy":16,"rx":8,"ry":4,"color":"#0044ff"}` |
| `ellipse.fill` | `cx`, `cy`, `rx`, `ry` (int, ≥1) | `color` / `slot` | `{"op":"ellipse.fill","cx":16,"cy":16,"rx":8,"ry":4,"color":"#0044ff"}` |
| `polyline` | `points`: [[x,y],...] 2 点以上 | `color` / `slot` / `thickness` / `closed` | `{"op":"polyline","points":[[0,0],[5,0],[5,5]],"closed":true,"color":"#000"}` |
| `polyline.fill` | `points`: [[x,y],...] 3 点以上 | `color` / `slot` | `{"op":"polyline.fill","points":[[0,0],[10,0],[5,8]],"color":"#00ff88"}` |
| `fill` | `x`, `y` (int) | `color` / `slot` | `{"op":"fill","x":0,"y":0,"color":"#cccccc"}` |
| `erase` | `x`, `y` (int) | (なし) | `{"op":"erase","x":4,"y":4}` |
| `palette.set` | `slot`, `color` | (なし) | `{"op":"palette.set","slot":"primary","color":"#ff0000"}` |
| `region.copy_paste` | `srcX`, `srcY`, `w`, `h`, `dstX`, `dstY` | `flipH` / `flipV` (boolean) | `{"op":"region.copy_paste","srcX":8,"srcY":8,"w":4,"h":4,"dstX":20,"dstY":8,"flipH":true}` |
| `text` | `x`, `y` (int), `text` (str) | `color` / `slot` / `scale` / `spacing` / `font` | `{"op":"text","x":2,"y":2,"text":"ねこ","color":"#000","font":"jp"}` |

**コツ:**
- 左右対称キャラ → 片側だけ描いて `region.copy_paste` + `flipH:true` で複製。 コマンド半分で済む。
- 目 / 頬 / 装飾の円 → `circle` か `circle.fill` 1 発。 dot を 4〜10 個並べない。
- 体の輪郭 → `polyline` + `thickness:2` 等で太線。 `line` 多段繋ぎより滑らかで短い。
- 文字 → `text` op。 既定は 3x5 大文字 ASCII (`font:"ascii"`)、 日本語は `font:"jp"` で 8x8 美咲ゴシック (ひらがな・カタカナ・JIS 第一水準漢字)。 32px キャンバスなら jp は 1 行 ~4 文字。

エラー時はサーバが「commands[N] op='X': <不足>\n引数仕様\n正しい呼び出し例\n渡された値」を返す。 同じ shape で再試行せず、 例に合わせて修正すること。

## 反復改善セッション運用
- `start_refinement_session` の goal にはユーザー要求をそのまま反映
- `get_refinement_prompt` → `vision_analyze` (pngPath と prompt をそのまま渡す) → `refine_with_feedback` で Vision JSON を渡す
- `done` / `stopReason` / `iterationLogs` を確認、 done でなければ次へ
- 停止後 `finalize_refinement` を呼ぶと、 反復過程のアニメ APNG が自動生成され `apngPath` が返る (`<canvas>.refinement.apng.png`)

## Vision への期待形式 (JSON)
```json
{
  "done": false,
  "summary": "赤い帽子が足りない",
  "missing": ["帽子上部の赤", "右目の位置"],
  "suggestedEdits": [
    {"op":"rect.fill","x":3,"y":1,"w":4,"h":2,"color":"#ff0000"}
  ]
}
```

## 守ること
- 1 回描いて終わらない (= inspect / Vision 経由で確認しない完了は禁止)
- Vision の提案に流される前に、 元戦略 (todo) との整合を確認
- 行き詰まったら `todo_mark(id, "blocked")` で自己宣言 → user 相談
- 無限ループ防止のため maxIterations と stopReason を確認
