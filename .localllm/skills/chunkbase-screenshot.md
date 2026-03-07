---
name: Chunkbase Seed Map Screenshot
description: Chunkbaseのシードマップの指定領域をスクリーンショットして保存します。
trigger: /chunkbase
---
# 概要
ユーザーから指定されたSeed値を元に、Chunkbaseシードマップの特定領域（キャンバス部分）のスクリーンショットを取得し、`screenshots`フォルダに保存するスキルです。

# 実行要件
- キャプチャ対象のWebサイト: https://www.chunkbase.com/apps/seed-map
- 対象要素: `<canvas data-tippy-content="" id="map-canvas" role="img" ...`
- 保存先: `screenshots` ディレクトリ
- ファイル命名規則: `minecraft-[seed:シード値]-[platform]-[現在の日時].png` (例: minecraft-1-bedrock-20250101_120000.png)

# 実行手順
1. コマンドの引数から `seed`（シード値）を取得します。引数がない場合は `ask_user` でユーザーにシード値を尋ねてください。
2. `platform` の指定がない場合はデフォルトのプラットフォーム名（例: `bedrock_26_0` の場合は `bedrock`）を使用します。
3. `current_datetime` ツールを使用して現在の日時を取得し、YYYYMMDD_HHMMSS 形式にフォーマットします。
4. 対象のURLを構成します:
   `https://www.chunkbase.com/apps/seed-map#seed={seed}&platform=bedrock_26_0&dimension=overworld&x=38&z=109&zoom=0.1`
   （※URL内の platform= 等のパラメータは適宜要件に合わせてください）
5. `browser_navigate` ツールで上記のURLを開きます。
6. マップの描画が完了するまで少し待機します。
7. （必要に応じて） `#map-canvas` が見えるように1スクリーン分下にスクロールするよう `browser_scroll` や `browser_action` などを実行します。
8. `browser_screenshot` ツールを使用して、スクリーンショットを撮影します。
   - `selector`引数に `"#map-canvas"` を指定すると、マップ部分のみをピンポイントでキャプチャできます。
   - 保存先パス（`path` 引数）には、生成したファイル名 `screenshots/minecraft-{seed}-{platform}-{datetime}.png` を指定します。
   - `screenshots` フォルダが存在しない場合は作成・保存できるようにしてください。
9. スクリーンショットの撮影と保存が成功したことをユーザーに報告してください。
