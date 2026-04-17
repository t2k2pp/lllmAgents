---
name: excel
description: Excelファイル(.xlsx)の作成スキル。表・集計・データ分析・帳票・レポート・スプレッドシート・xlsxを作成するよう求められたときに使用する。openpyxlでネイティブXLSXファイルを生成する。
tools: [bash, file_write, file_read]
---

# Excel Spreadsheet Skill

openpyxlで`.xlsx`ファイルを生成する。以下の手順に**厳密に従うこと**。

## 絶対ルール

- openpyxlがなければ先に `pip install openpyxl` を実行
- 出力先は `output/` 配下
- **ヘッダー行は必ず背景色・太字・フィルター・枠固定を設定**する
- **列幅は必ず内容に合わせて調整**する（デフォルト幅のまま放置禁止）
- CSVではなく`.xlsx`で出力する
- **生成スクリプト（.py）は必ず.xlsxと同じディレクトリに残す**（後の編集で再利用するため）

## スクリプト再利用ワークフロー（編集依頼時）

ユーザーから既存XLSXの修正・変更を依頼された場合、以下の順で対応する:

1. **スクリプト(.py)の存在を確認**: .xlsxと同じディレクトリに `*_generate.py` があるか確認
2. **タイムスタンプを比較**: スクリプトと.xlsxの更新日時を比較する
   ```bash
   stat -c '%Y %n' output/report_generate.py output/report.xlsx
   ```
   - **一致 or スクリプトが新しい** → スクリプトが信頼できる。**スクリプトを読んで修正→再実行**
   - **xlsxがスクリプトより新しい** → ユーザーが手動編集した可能性あり。ユーザーに確認する:「XLSXが手動で編集されている可能性があります。スクリプトから再生成してよいですか？」
3. **スクリプトがない場合** → .xlsxを解析して新規スクリプトを作成

**スクリプトがある場合は.xlsxの解析は不要。スクリプトのコードを読む方が正確で効率的。**

## 手順

### Step 1: 要件整理
用途・データ・シート数・必要機能をユーザーに確認（明示済みなら省略）。

### Step 2: シート設計
構造を提示して合意を得る。

### Step 3: Pythonスクリプト作成・実行

以下のコードをベースとして`file_write`で`output/[ディレクトリ]/[名前]_generate.py`に保存し、`bash`で実行する。
**データ内容・列定義はユーザーの要件に合わせて書き換える。ヘルパー関数とスタイル定義はそのまま使う。**

```python
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.formatting.rule import CellIsRule, DataBarRule
import os

# ============================================================
# スタイル定義（色・フォントはここだけ変更すればOK）
# ============================================================
PRIMARY_COLOR = '1A56DB'
ACCENT_COLOR  = 'FF6B35'
LIGHT_BG      = 'F0F4F8'
WHITE         = 'FFFFFF'
RED_BG        = 'FFC7CE'
GREEN_BG      = 'C6EFCE'
FONT_NAME     = 'Meiryo'

HEADER_FONT  = Font(name=FONT_NAME, bold=True, color=WHITE, size=11)
HEADER_FILL  = PatternFill(start_color=PRIMARY_COLOR, end_color=PRIMARY_COLOR, fill_type='solid')
HEADER_ALIGN = Alignment(horizontal='center', vertical='center', wrap_text=True)

BODY_FONT    = Font(name=FONT_NAME, size=10)
BODY_ALIGN   = Alignment(vertical='center', wrap_text=True)
NUM_ALIGN    = Alignment(horizontal='right', vertical='center')

THIN_BORDER  = Border(
    left=Side(style='thin'), right=Side(style='thin'),
    top=Side(style='thin'),  bottom=Side(style='thin'),
)
TOTAL_BORDER = Border(
    left=Side(style='thin'), right=Side(style='thin'),
    top=Side(style='double'), bottom=Side(style='thin'),
)
TOTAL_FONT   = Font(name=FONT_NAME, bold=True, size=10)
TOTAL_FILL   = PatternFill(start_color='E8F0FE', end_color='E8F0FE', fill_type='solid')

STRIPE_FILL  = PatternFill(start_color=LIGHT_BG, end_color=LIGHT_BG, fill_type='solid')

# ============================================================
# ヘルパー関数（全シートで使い回す）
# ============================================================

def style_header(ws, headers, row=1):
    """ヘッダー行にスタイルを適用し、フィルターと枠固定を設定"""
    for col_num, header in enumerate(headers, 1):
        cell = ws.cell(row=row, column=col_num, value=header)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = HEADER_ALIGN
        cell.border = THIN_BORDER
    # フィルター
    last_col = get_column_letter(len(headers))
    ws.auto_filter.ref = f'A{row}:{last_col}{row}'
    # ヘッダー行を固定
    ws.freeze_panes = f'A{row + 1}'

def style_data_rows(ws, start_row, end_row, num_cols, stripe=True):
    """データ行にフォント・罫線・ストライプを適用"""
    for r in range(start_row, end_row + 1):
        for c in range(1, num_cols + 1):
            cell = ws.cell(row=r, column=c)
            cell.font = BODY_FONT
            cell.alignment = BODY_ALIGN
            cell.border = THIN_BORDER
            # 偶数行にストライプ背景
            if stripe and r % 2 == 0:
                cell.fill = STRIPE_FILL

def style_total_row(ws, row, num_cols):
    """合計行にスタイルを適用"""
    for c in range(1, num_cols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = TOTAL_FONT
        cell.fill = TOTAL_FILL
        cell.border = TOTAL_BORDER

def auto_column_width(ws):
    """全列の幅を内容に合わせて自動調整（日本語対応）"""
    for col in ws.columns:
        max_length = 0
        col_letter = get_column_letter(col[0].column)
        for cell in col:
            if cell.value is not None:
                length = sum(2 if ord(c) > 127 else 1 for c in str(cell.value))
                max_length = max(max_length, length)
        ws.column_dimensions[col_letter].width = min(max_length + 4, 50)

def set_number_format(ws, col, start_row, end_row, fmt):
    """指定列の数値書式を設定"""
    for r in range(start_row, end_row + 1):
        ws.cell(row=r, column=col).number_format = fmt
        ws.cell(row=r, column=col).alignment = NUM_ALIGN

# ============================================================
# ワークブック作成
# ============================================================
wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'データ'

# ============================================================
# ヘッダー定義
# ============================================================
headers = ['月', '商品名', '数量', '単価', '売上', '前月比']
style_header(ws, headers)

# ============================================================
# サンプルデータ投入
# ============================================================
data = [
    ['2026/01', '商品A', 120, 1500, None, None],
    ['2026/01', '商品B',  80, 2000, None, None],
    ['2026/02', '商品A', 150, 1500, None, None],
    ['2026/02', '商品B',  95, 2000, None, None],
    ['2026/03', '商品A', 180, 1500, None, None],
    ['2026/03', '商品B', 110, 2000, None, None],
]

for i, row_data in enumerate(data):
    row_num = i + 2
    for j, val in enumerate(row_data):
        ws.cell(row=row_num, column=j + 1, value=val)
    # 売上 = 数量 × 単価（数式）
    ws.cell(row=row_num, column=5, value=f'=C{row_num}*D{row_num}')

last_row = len(data) + 1

# ============================================================
# データ行スタイル
# ============================================================
style_data_rows(ws, 2, last_row, len(headers))

# 数値書式
set_number_format(ws, 3, 2, last_row, '#,##0')       # 数量
set_number_format(ws, 4, 2, last_row, '#,##0')       # 単価
set_number_format(ws, 5, 2, last_row, '#,##0')       # 売上
set_number_format(ws, 6, 2, last_row, '0.0%')        # 前月比

# ============================================================
# 合計行
# ============================================================
total_row = last_row + 1
ws.cell(row=total_row, column=1, value='合計')
ws.cell(row=total_row, column=3, value=f'=SUM(C2:C{last_row})')
ws.cell(row=total_row, column=5, value=f'=SUM(E2:E{last_row})')
style_total_row(ws, total_row, len(headers))
set_number_format(ws, 3, total_row, total_row, '#,##0')
set_number_format(ws, 5, total_row, total_row, '#,##0')

# ============================================================
# 条件付き書式（売上列にデータバー）
# ============================================================
ws.conditional_formatting.add(
    f'E2:E{last_row}',
    DataBarRule(start_type='min', end_type='max', color=PRIMARY_COLOR)
)

# ============================================================
# 列幅の自動調整
# ============================================================
auto_column_width(ws)

# ============================================================
# グラフシート（必要な場合のみ）
# ============================================================
ws_chart = wb.create_sheet('グラフ')

chart = BarChart()
chart.type = 'col'
chart.style = 10
chart.title = '月次売上推移'
chart.y_axis.title = '売上（円）'
chart.x_axis.title = '月'
chart.y_axis.numFmt = '#,##0'

chart_data = Reference(ws, min_col=5, min_row=1, max_row=last_row)
chart_cats = Reference(ws, min_col=1, min_row=2, max_row=last_row)
chart.add_data(chart_data, titles_from_data=True)
chart.set_categories(chart_cats)
chart.shape = 4
chart.width = 20
chart.height = 12

ws_chart.add_chart(chart, 'A1')

# ============================================================
# 印刷設定
# ============================================================
ws.page_setup.orientation = ws.ORIENTATION_LANDSCAPE
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 0
ws.print_title_rows = '1:1'
ws.sheet_properties.pageSetUpPr.fitToPage = True

# ============================================================
# 保存
# ============================================================
output_dir = os.path.join(os.getcwd(), 'output')
os.makedirs(output_dir, exist_ok=True)
filepath = os.path.join(output_dir, 'report.xlsx')
wb.save(filepath)
print(f'Saved: {filepath}')
```

### Step 4: 保存と確認
1. スクリプトを `output/[ディレクトリ]/[名前]_generate.py` に保存
2. `bash` でスクリプト実行、`.xlsx` が同ディレクトリに生成されることを確認
3. ユーザーに**スクリプトパスとXLSXパスの両方**を報告（「次回の編集はスクリプトを修正して再実行します」と伝える）

## 追加要素のコード例

必要に応じて上記テンプレートに追加する。**必ずヘルパー関数（`style_header`, `style_data_rows`, `auto_column_width`等）を使うこと。**

### 条件付き書式（値による色分け）
```python
red_fill = PatternFill(start_color=RED_BG, end_color=RED_BG, fill_type='solid')
green_fill = PatternFill(start_color=GREEN_BG, end_color=GREEN_BG, fill_type='solid')

ws.conditional_formatting.add(
    f'E2:E{last_row}',
    CellIsRule(operator='lessThan', formula=['100000'], fill=red_fill)
)
ws.conditional_formatting.add(
    f'E2:E{last_row}',
    CellIsRule(operator='greaterThanOrEqual', formula=['100000'], fill=green_fill)
)
```

### 集計シート（別シートから参照）
```python
ws_summary = wb.create_sheet('集計')
summary_headers = ['商品名', '合計売上', '件数', '平均売上']
style_header(ws_summary, summary_headers)

products = ['商品A', '商品B']
for i, prod in enumerate(products):
    r = i + 2
    ws_summary.cell(row=r, column=1, value=prod)
    ws_summary.cell(row=r, column=2, value=f'=SUMIF(データ!B:B,A{r},データ!E:E)')
    ws_summary.cell(row=r, column=3, value=f'=COUNTIF(データ!B:B,A{r})')
    ws_summary.cell(row=r, column=4, value=f'=AVERAGEIF(データ!B:B,A{r},データ!E:E)')

style_data_rows(ws_summary, 2, len(products) + 1, len(summary_headers))
set_number_format(ws_summary, 2, 2, len(products) + 1, '#,##0')
set_number_format(ws_summary, 4, 2, len(products) + 1, '#,##0')
auto_column_width(ws_summary)
```

### 円グラフ
```python
pie = PieChart()
pie.title = '商品別売上構成'
pie.style = 10
pie_data = Reference(ws_summary, min_col=2, min_row=1, max_row=len(products) + 1)
pie_cats = Reference(ws_summary, min_col=1, min_row=2, max_row=len(products) + 1)
pie.add_data(pie_data, titles_from_data=True)
pie.set_categories(pie_cats)
pie.width = 15
pie.height = 10
ws_chart.add_chart(pie, 'A20')
```

### 折れ線グラフ
```python
line = LineChart()
line.title = '推移グラフ'
line.style = 10
line.y_axis.numFmt = '#,##0'
line_data = Reference(ws, min_col=5, min_row=1, max_row=last_row)
line_cats = Reference(ws, min_col=1, min_row=2, max_row=last_row)
line.add_data(line_data, titles_from_data=True)
line.set_categories(line_cats)
line.width = 20
line.height = 12
ws_chart.add_chart(line, 'A1')
```

## 数値書式リファレンス
| 用途 | 書式コード |
|------|-----------|
| 整数カンマ区切り | `#,##0` |
| 通貨（円） | `¥#,##0` |
| 通貨（ドル） | `$#,##0.00` |
| パーセント | `0.0%` |
| 日付 | `YYYY/MM/DD` |
| 日時 | `YYYY/MM/DD HH:MM` |
| 小数2桁 | `#,##0.00` |

## 完了条件
- `.xlsx`が正常生成されエラーなし
- **生成スクリプト（`*_generate.py`）が.xlsxと同ディレクトリに残っている**
- ヘッダー行が青背景・白太字・フィルター付き
- 列幅が内容に合わせて調整済み
- 偶数行にストライプ背景あり
- フォントがMeiryo指定済み
- ヘッダー行が枠固定（freeze_panes）されている
