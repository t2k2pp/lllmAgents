---
name: ascii-art
description: 画像ファイルをASCIIアートに変換するスキル。画像を文字絵にしたい、PNG/JPG/WebPをテキスト化したい、ターミナル向けに白黒のASCIIプレビューを作りたい、画像を @#*+=-:. のような文字で表現したいときに使用する。固定的なプログラム手順で再現可能なASCIIアートを生成し、成果物はsandbox配下へ保存する。
tools: [file_read, file_write, bash, ask_user, glob]
---

# ASCII Art Skill

画像を規則的な濃淡マッピングでASCIIアートへ変換する。毎回手で文字を並べるのではなく、**固定手順のスクリプトで再現可能に生成する**。

## このスキルを使う場面

- 画像をASCIIアートにしてほしい
- PNG/JPG/WebPを文字ベースでプレビューしたい
- 画像を `.txt` や Markdown に埋めたい
- ターミナル表示向けに白黒の文字絵へ落としたい

## 絶対ルール

- 出力先は原則 `sandbox/` 配下
- 画像パス・出力パスは**絶対パス**を使う
- ASCIIアート本文を会話に貼って終わらず、**必ずファイル保存**する
- 変換に使ったスクリプトも**同じディレクトリに残す**
- 相対パスは禁止

## デフォルト仕様

- 横幅: `80`
- 文字セット: `@%#*+=-:. `
- 縦横比補正: `0.5`
- 出力形式: `.txt`

## 手順

### Step 1: 要件確認
以下が不明なら確認する。明示済みなら省略してよい。

- 入力画像の絶対パス
- 出力先の絶対パス
- 横幅（未指定なら80）
- 文字セット変更の有無

出力先未指定時は、入力画像名をもとに `sandbox/` 配下へ保存する。
例:
- 入力: `/abs/path/cat.png`
- 出力: `/Users/.../sandbox/cat-ascii.txt`
- スクリプト: `/Users/.../sandbox/cat-ascii.py`

### Step 2: 入力確認
`file_read` は画像に使えないため、必要に応じて `glob` や `bash` (`test -f`) で入力画像の存在を確認する。

### Step 3: 変換スクリプト作成
以下のPythonスクリプトをベースに、出力先と必要パラメータを埋めて `file_write` で保存する。保存先はASCII出力と同じディレクトリにする。

```python
from PIL import Image

INPUT_PATH = r"/ABS/PATH/INPUT.png"
OUTPUT_PATH = r"/ABS/PATH/OUTPUT.txt"
WIDTH = 80
CHARS = "@%#*+=-:. "
ASPECT = 0.5

img = Image.open(INPUT_PATH).convert("L")
orig_w, orig_h = img.size
new_h = max(1, int((orig_h / orig_w) * WIDTH * ASPECT))
img = img.resize((WIDTH, new_h))

pixels = list(img.getdata())
lines = []
for y in range(new_h):
    row = pixels[y * WIDTH:(y + 1) * WIDTH]
    chars = []
    for px in row:
        idx = int(px / 255 * (len(CHARS) - 1))
        chars.append(CHARS[idx])
    lines.append("".join(chars))

ascii_art = "\n".join(lines)
with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
    f.write(ascii_art)

print(f"written: {OUTPUT_PATH}")
```

## Step 4: 実行
`bash` で実行する。

- Pillow がなければ先に `python3 -c "import PIL"` で確認
- なければ `python3 -m pip install pillow` を実行してから再実行

典型例:

```bash
python3 /ABS/PATH/OUTPUT_SCRIPT.py
```

## Step 5: 軽い検証
生成後、`.txt` を `file_read` で先頭数十行確認し、以下を見る。

- 空ファイルでない
- 極端に縦長/横長に崩れていない
- 文字セットが潰れすぎていない

必要なら幅を 60 / 80 / 100 などに変えて再生成する。

## Step 6: 報告
必ず以下を報告する。

- ASCIIアート出力ファイルの絶対パス
- 生成スクリプトの絶対パス
- 指定した幅や文字セット

## 実務上の判断基準

- 細かい画像は幅80〜120が向く
- 小さいアイコンやロゴは幅40〜60でもよい
- コントラストが弱い画像は文字セットを短くすると見やすい
- 写真は `@%#*+=-:. `、線画は `@#*-. ` など短め文字セットも有効

## やってはいけないこと

- 画像を見ずに手打ちでそれっぽい文字絵を返す
- sandbox外へユーザー成果物を出す
- スクリプトを残さず `.txt` だけ生成する
- 相対パスで保存する
