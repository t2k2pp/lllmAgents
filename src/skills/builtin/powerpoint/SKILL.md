---
name: powerpoint
description: PowerPointプレゼンテーション(.pptx)の作成スキル。スライド・プレゼン・発表資料・提案書・pptx・パワポを作成するよう求められたときに使用する。python-pptxでネイティブPPTXファイルを生成する。
tools: [bash, file_write, file_read]
---

# PowerPoint Presentation Skill

python-pptxで`.pptx`ファイルを生成する。以下の手順に**厳密に従うこと**。

## 絶対ルール

- デフォルトテンプレートのレイアウト（`prs.slide_layouts[N]`）は**使用禁止**。全スライドを`prs.slide_layouts[6]`（空白レイアウト）で作成し、図形・テキストボックスを手動配置する
- python-pptxがなければ先に `pip install python-pptx` を実行
- 出力先は `output/` 配下
- 1スライドの箇条書きは5項目以内

## 手順

### Step 1: 要件整理
目的・スライド数・内容をユーザーに確認（明示済みなら省略）。

### Step 2: 構成設計
スライド一覧を提示して合意を得る。

### Step 3: Pythonスクリプト作成・実行

以下のコードをベースとして`file_write`で保存し、`bash`で実行する。
**スライド内容（タイトル・箇条書き等）はユーザーの要件に合わせて書き換える。ヘルパー関数とスタイル定義はそのまま使う。**

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
import os

# ============================================================
# テーマ設定（色・フォントはここだけ変更すればOK）
# ============================================================
PRIMARY   = RGBColor(0x1A, 0x56, 0xDB)  # 濃い青
SECONDARY = RGBColor(0x2D, 0x3A, 0x4A)  # ダークグレー
ACCENT    = RGBColor(0xFF, 0x6B, 0x35)  # オレンジ
WHITE     = RGBColor(0xFF, 0xFF, 0xFF)
LIGHT_BG  = RGBColor(0xF0, 0xF4, 0xF8)  # 薄いグレー背景
TEXT_DARK = RGBColor(0x1A, 0x1A, 0x2E)
TEXT_GRAY = RGBColor(0x6B, 0x72, 0x80)
FONT      = 'Meiryo'

# ============================================================
# プレゼンテーション初期化（16:9）
# ============================================================
prs = Presentation()
prs.slide_width  = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK_LAYOUT = prs.slide_layouts[6]  # 空白レイアウトのみ使用

# ============================================================
# ヘルパー関数（全スライドで使い回す）
# ============================================================

def set_slide_bg(slide, color):
    """スライド背景を単色で塗る"""
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = color

def add_textbox(slide, left, top, width, height, text,
                font_size=18, bold=False, color=TEXT_DARK,
                align=PP_ALIGN.LEFT, font_name=FONT):
    """テキストボックスを追加して書式設定済みで返す"""
    txBox = slide.shapes.add_textbox(
        Inches(left), Inches(top), Inches(width), Inches(height)
    )
    tf = txBox.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = text
    p.font.size = Pt(font_size)
    p.font.bold = bold
    p.font.color.rgb = color
    p.font.name = font_name
    p.alignment = align
    return txBox

def add_bullet_list(slide, left, top, width, height, items,
                    font_size=18, color=TEXT_DARK):
    """箇条書きテキストボックスを追加"""
    txBox = slide.shapes.add_textbox(
        Inches(left), Inches(top), Inches(width), Inches(height)
    )
    tf = txBox.text_frame
    tf.word_wrap = True
    for i, item in enumerate(items):
        if i == 0:
            p = tf.paragraphs[0]
        else:
            p = tf.add_paragraph()
        p.text = item
        p.font.size = Pt(font_size)
        p.font.color.rgb = color
        p.font.name = FONT
        p.space_after = Pt(8)
        p.level = 0
        # 箇条書き記号を手動付与
        p.text = f"●  {item}"
    return txBox

def add_accent_bar(slide, left, top, width, height, color=PRIMARY):
    """アクセントバー（細い矩形）を追加"""
    shape = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE,
        Inches(left), Inches(top), Inches(width), Inches(height)
    )
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    return shape

def add_page_number(slide, num, total):
    """右下にページ番号を追加"""
    add_textbox(slide, 11.5, 7.0, 1.5, 0.4,
                f"{num} / {total}", font_size=10,
                color=TEXT_GRAY, align=PP_ALIGN.RIGHT)

# ============================================================
# スライド1: タイトル（背景色付き）
# ============================================================
slide = prs.slides.add_slide(BLANK_LAYOUT)
set_slide_bg(slide, PRIMARY)

# 左側にアクセントバー
add_accent_bar(slide, 0.8, 1.5, 0.08, 4.0, ACCENT)

# タイトル
add_textbox(slide, 1.2, 2.0, 10.0, 1.5,
            "プレゼンテーションタイトル",
            font_size=44, bold=True, color=WHITE,
            align=PP_ALIGN.LEFT)

# サブタイトル
add_textbox(slide, 1.2, 3.8, 10.0, 0.8,
            "サブタイトル ～補足説明～",
            font_size=24, color=RGBColor(0xCC, 0xDD, 0xFF),
            align=PP_ALIGN.LEFT)

# 発表者・日付
add_textbox(slide, 1.2, 5.5, 10.0, 0.5,
            "発表者名  |  2026年4月",
            font_size=16, color=RGBColor(0xAA, 0xBB, 0xDD),
            align=PP_ALIGN.LEFT)

# ============================================================
# スライド2: 目次（アジェンダ）
# ============================================================
slide = prs.slides.add_slide(BLANK_LAYOUT)
set_slide_bg(slide, WHITE)

# タイトル
add_textbox(slide, 0.8, 0.4, 11.0, 0.8,
            "アジェンダ", font_size=32, bold=True, color=PRIMARY)

# タイトル下のアクセントバー
add_accent_bar(slide, 0.8, 1.15, 2.0, 0.06, PRIMARY)

# 目次項目（番号付き）
agenda_items = [
    "1.  背景と目的",
    "2.  現状分析",
    "3.  提案内容",
    "4.  実施計画",
    "5.  まとめ・次のステップ",
]
for i, item in enumerate(agenda_items):
    y = 1.8 + i * 0.9
    # 番号の背景丸
    circle = slide.shapes.add_shape(
        MSO_SHAPE.OVAL,
        Inches(0.9), Inches(y), Inches(0.5), Inches(0.5)
    )
    circle.fill.solid()
    circle.fill.fore_color.rgb = PRIMARY
    circle.line.fill.background()
    # 丸の中の番号
    tf = circle.text_frame
    tf.paragraphs[0].text = str(i + 1)
    tf.paragraphs[0].font.size = Pt(16)
    tf.paragraphs[0].font.bold = True
    tf.paragraphs[0].font.color.rgb = WHITE
    tf.paragraphs[0].font.name = FONT
    tf.paragraphs[0].alignment = PP_ALIGN.CENTER
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    # テキスト
    add_textbox(slide, 1.7, y + 0.05, 9.0, 0.5,
                item.split(". ", 1)[-1] if ". " in item else item,
                font_size=20, color=TEXT_DARK)

add_page_number(slide, 2, 5)

# ============================================================
# スライド3: コンテンツ（箇条書き）
# ============================================================
slide = prs.slides.add_slide(BLANK_LAYOUT)
set_slide_bg(slide, WHITE)

# タイトル
add_textbox(slide, 0.8, 0.4, 11.0, 0.8,
            "セクションタイトル", font_size=32, bold=True, color=PRIMARY)
add_accent_bar(slide, 0.8, 1.15, 2.0, 0.06, PRIMARY)

# 箇条書き
add_bullet_list(slide, 0.8, 1.6, 11.0, 4.5, [
    "ポイント1: 具体的な内容を記載する",
    "ポイント2: データや根拠を添えると説得力が増す",
    "ポイント3: 1スライド5項目以内に抑える",
    "ポイント4: 簡潔に、1行40文字以内を目安に",
], font_size=20)

add_page_number(slide, 3, 5)

# ============================================================
# スライド4: 2カラム比較
# ============================================================
slide = prs.slides.add_slide(BLANK_LAYOUT)
set_slide_bg(slide, WHITE)

add_textbox(slide, 0.8, 0.4, 11.0, 0.8,
            "Before / After 比較", font_size=32, bold=True, color=PRIMARY)
add_accent_bar(slide, 0.8, 1.15, 2.0, 0.06, PRIMARY)

# 左カラム（Before）
left_box = slide.shapes.add_shape(
    MSO_SHAPE.ROUNDED_RECTANGLE,
    Inches(0.8), Inches(1.8), Inches(5.5), Inches(4.5)
)
left_box.fill.solid()
left_box.fill.fore_color.rgb = LIGHT_BG
left_box.line.fill.background()

add_textbox(slide, 1.2, 2.0, 4.5, 0.6,
            "Before", font_size=24, bold=True, color=SECONDARY)
add_bullet_list(slide, 1.2, 2.7, 4.5, 3.0, [
    "従来の方法A",
    "課題が多い",
    "効率が低い",
], font_size=18, color=TEXT_DARK)

# 右カラム（After）
right_box = slide.shapes.add_shape(
    MSO_SHAPE.ROUNDED_RECTANGLE,
    Inches(6.8), Inches(1.8), Inches(5.5), Inches(4.5)
)
right_box.fill.solid()
right_box.fill.fore_color.rgb = RGBColor(0xE8, 0xF0, 0xFE)
right_box.line.fill.background()

add_textbox(slide, 7.2, 2.0, 4.5, 0.6,
            "After", font_size=24, bold=True, color=PRIMARY)
add_bullet_list(slide, 7.2, 2.7, 4.5, 3.0, [
    "新しい方法B",
    "課題を解決",
    "効率が大幅向上",
], font_size=18, color=TEXT_DARK)

add_page_number(slide, 4, 5)

# ============================================================
# スライド5: まとめ（Thank You）
# ============================================================
slide = prs.slides.add_slide(BLANK_LAYOUT)
set_slide_bg(slide, PRIMARY)

add_textbox(slide, 1.0, 1.5, 11.0, 1.2,
            "まとめ", font_size=36, bold=True, color=WHITE,
            align=PP_ALIGN.CENTER)

add_accent_bar(slide, 5.5, 2.7, 2.0, 0.06, ACCENT)

# まとめポイント
summary_items = [
    "✓  ポイント1の要約",
    "✓  ポイント2の要約",
    "✓  ポイント3の要約",
]
for i, item in enumerate(summary_items):
    add_textbox(slide, 2.0, 3.2 + i * 0.8, 9.0, 0.6,
                item, font_size=22, color=WHITE)

add_textbox(slide, 1.0, 5.8, 11.0, 0.8,
            "ご清聴ありがとうございました",
            font_size=28, bold=True, color=RGBColor(0xCC, 0xDD, 0xFF),
            align=PP_ALIGN.CENTER)

# ============================================================
# 保存
# ============================================================
output_dir = os.path.join(os.getcwd(), 'output')
os.makedirs(output_dir, exist_ok=True)
filepath = os.path.join(output_dir, 'presentation.pptx')
prs.save(filepath)
print(f'Saved: {filepath}')
```

### Step 4: 保存と確認
1. `output/[プレゼン名].pptx` に保存
2. `bash` でスクリプト実行、エラーがないことを確認
3. ユーザーにファイルパスを報告

## スライドタイプの追加方法

上記テンプレートの各スライドブロックをコピーして内容を書き換える。**必ずヘルパー関数（`add_textbox`, `add_bullet_list`, `add_accent_bar`, `set_slide_bg`）を使うこと。**

### セクション区切りスライド
```python
slide = prs.slides.add_slide(BLANK_LAYOUT)
set_slide_bg(slide, SECONDARY)
add_textbox(slide, 1.0, 2.5, 11.0, 1.5,
            "Section 2", font_size=20, color=TEXT_GRAY, align=PP_ALIGN.CENTER)
add_textbox(slide, 1.0, 3.2, 11.0, 1.5,
            "セクション名", font_size=40, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
add_accent_bar(slide, 5.5, 4.5, 2.0, 0.06, ACCENT)
```

### テーブルスライド
```python
slide = prs.slides.add_slide(BLANK_LAYOUT)
set_slide_bg(slide, WHITE)
add_textbox(slide, 0.8, 0.4, 11.0, 0.8,
            "テーブルタイトル", font_size=32, bold=True, color=PRIMARY)
add_accent_bar(slide, 0.8, 1.15, 2.0, 0.06, PRIMARY)

rows, cols = 4, 3
tbl = slide.shapes.add_table(
    rows, cols, Inches(0.8), Inches(1.6), Inches(11.5), Inches(4.5)
).table
# ヘッダー行
for ci, header in enumerate(["項目", "値", "備考"]):
    cell = tbl.cell(0, ci)
    cell.text = header
    cell.fill.solid()
    cell.fill.fore_color.rgb = PRIMARY
    for p in cell.text_frame.paragraphs:
        p.font.size = Pt(16)
        p.font.bold = True
        p.font.color.rgb = WHITE
        p.font.name = FONT
        p.alignment = PP_ALIGN.CENTER
# データ行
data = [["項目A", "100", "説明"], ["項目B", "200", "説明"], ["項目C", "300", "説明"]]
for ri, row_data in enumerate(data, start=1):
    for ci, val in enumerate(row_data):
        cell = tbl.cell(ri, ci)
        cell.text = val
        # 偶数行に薄い背景色
        if ri % 2 == 0:
            cell.fill.solid()
            cell.fill.fore_color.rgb = LIGHT_BG
        for p in cell.text_frame.paragraphs:
            p.font.size = Pt(14)
            p.font.color.rgb = TEXT_DARK
            p.font.name = FONT
```

## テーマカラーのバリエーション

必要に応じて以下の配色に差し替える:

```python
# ビジネスブルー（デフォルト）
PRIMARY = RGBColor(0x1A, 0x56, 0xDB); ACCENT = RGBColor(0xFF, 0x6B, 0x35)
# グリーン（環境・成長）
PRIMARY = RGBColor(0x05, 0x96, 0x69); ACCENT = RGBColor(0xF5, 0x9E, 0x0B)
# レッド（緊急・インパクト）
PRIMARY = RGBColor(0xDC, 0x26, 0x26); ACCENT = RGBColor(0x25, 0x63, 0xEB)
# パープル（クリエイティブ）
PRIMARY = RGBColor(0x79, 0x24, 0xC7); ACCENT = RGBColor(0x06, 0xB6, 0xD4)
```

## 完了条件
- `.pptx`が正常生成されエラーなし
- 全スライドに背景色 or アクセントバーのデザイン要素がある
- フォントがMeiryo指定済み
- 16:9サイズ（13.333 x 7.5 inch）
