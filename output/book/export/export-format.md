# PDF/HTML 出力用フォーマット

## 書籍 1：抵抗勢力を黙らせた上で信者にする生成 AI の社内導入

### 出力フォーマット一覧

| フォーマット | 用途 | ファイル名 |
|------------|-|-----------|
| PDF（印刷用） | 印刷出版 | book1-print.pdf |
| PDF（電子書籍） | 電子書籍配布 | book1-ebook.pdf |
| HTML（シングル） | Web 公開 | book1.html |
| HTML（マルチページ） | Web サイト | book1-site/ |
| EPUB | Kindle 等 | book1.epub |
| MOBI | Kindle 専用 | book1.mobi |

---

## PDF 出力（印刷用）

### 仕様の

**サイズ：** A5（148 x 210 mm）

**余白：**
- 上：20 mm
- 下：20 mm
- 左：20 mm
- 右：20 mm
- 綴じ代：5 mm

**文字サイズ：**
- 本文：10 pt（明朝体）
- 見出し 1：16 pt（ゴシック体、太字）
- 見出し 2：14 pt（ゴシック体、太字）
- 見出し 3：12 pt（ゴシック体、太字）
- 脚注：8 pt（明朝体）

**行間：** 1.5 行

**フォント：**
- 本文：游明朝 / 小塚明朝
- 見出し：游ゴシック / 小塚ゴシック
- 英語：Arial / Helvetica

**カラーモード：** CMYK

**解像度：** 300 DPI

**画像：**
- 解像度：300 DPI 以上
- カラーモード：CMYK
- 形式：TIFF / JPEG（高品質）

**出血：** 3 mm（各辺）

---

## PDF 出力（電子書籍用）

### 仕様の

**サイズ：** A5（148 x 210 mm）

**余白：**
- 上：15 mm
- 下：15 mm
- 左：15 mm
- 右：15 mm

**文字サイズ：**
- 本文：11 pt（明朝体）
- 見出し 1：18 pt（ゴシック体、太字）
- 見出し 2：16 pt（ゴシック体、太字）
- 見出し 3：14 pt（ゴシック体、太字）

**行間：** 1.6 行

**フォント：**
- 本文：游明朝 / 小塚明朝
- 見出し：游ゴシック / 小塚ゴシック
- 英語：Arial / Helvetica

**カラーモード：** sRGB

**解像度：** 150 DPI

**画像：**
- 解像度：150 DPI 以上
- カラーモード：sRGB
- 形式：JPEG（中品質）

**ファイルサイズ：** 50 MB 以下（圧縮推奨）

---

## HTML 出力（シングルページ）

### 構造

```html
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>抵抗勢力を黙らせた上で信者にする生成 AI の社内導入</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header>
        <h1>抵抗勢力を黙らせた上で信者にする生成 AI の社内導入</h1>
        <p class="subtitle">実戦的 AI 導入完全ガイド</p>
        <p class="author">著：田中 太郎</p>
    </header>
    
    <nav id="toc">
        <h2>目次</h2>
        <ul>
            <li><a href="#chapter-01">第 1 章：生成 AI 導入の現状と課題</a></li>
            <li><a href="#chapter-02">第 2 章：抵抗勢力の正体と心理</a></li>
            <!-- 以下同様 -->
        </ul>
    </nav>
    
    <main>
        <section id="chapter-01">
            <h2>第 1 章：生成 AI 導入の現状と課題</h2>
            <!-- 本文 -->
        </section>
        <!-- 以下同様 -->
    </main>
    
    <footer>
        <p>&copy; 2025 技術評論社</p>
    </footer>
</body>
</html>
```

### CSS スタイル

```css
/* styles.css */
:root {
    --primary-color: #2563eb;
    --secondary-color: #7c3aed;
    --text-color: #1f2937;
    --background-color: #ffffff;
    --heading-font: 'Hiragino Sans', '游ゴシック', sans-serif;
    --body-font: 'Hiragino Mincho', '游明朝', serif;
}

body {
    font-family: var(--body-font);
    line-height: 1.8;
    color: var(--text-color);
    background-color: var(--background-color);
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
}

h1, h2, h3, h4 {
    font-family: var(--heading-font);
    color: var(--primary-color);
}

h1 {
    font-size: 2.5em;
    text-align: center;
    margin-bottom: 0.5em;
}

h2 {
    font-size: 1.8em;
    margin-top: 2em;
    border-bottom: 2px solid var(--primary-color);
    padding-bottom: 0.5em;
}

h3 {
    font-size: 1.4em;
    margin-top: 1.5em;
}

p {
    margin-bottom: 1.5em;
    text-align: justify;
}

#toc {
    background-color: #f3f4f6;
    padding: 20px;
    border-radius: 8px;
    margin: 20px 0;
}

#toc ul {
    list-style-type: none;
    padding: 0;
}

#toc li {
    margin-bottom: 0.5em;
}

#toc a {
    color: var(--primary-color);
    text-decoration: none;
}

#toc a:hover {
    text-decoration: underline;
}

footer {
    text-align: center;
    margin-top: 40px;
    padding-top: 20px;
    border-top: 1px solid #e5e7eb;
}

@media (max-width: 768px) {
    body {
        padding: 10px;
    }
    
    h1 {
        font-size: 2em;
    }
    
    h2 {
        font-size: 1.5em;
    }
}
```

---

## HTML 出力（マルチページ）

### ディレクトリ構造

```
book1-site/
├── index.html          # 表紙・目次
├── chapter-01.html     # 第 1 章
├── chapter-02.html     # 第 2 章
├── ...
├── chapter-08.html     # 第 8 章
├── appendix/
│   ├── appendix-a.html # 付録 A
│   ├── appendix-b.html # 付録 B
│   ├── appendix-c.html # 付録 C
│   └── appendix-d.html # 付録 D
├── styles/
│   └── main.css        # スタイルシート
└── assets/
    ├── images/         # 画像
    └── fonts/          # フォント
```

### index.html（表紙・目次）

```html
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>抵抗勢力を黙らせた上で信者にする生成 AI の社内導入</title>
    <link rel="stylesheet" href="styles/main.css">
</head>
<body>
    <header class="cover">
        <div class="cover-content">
            <h1>抵抗勢力を黙らせた上で<br>信者にする<br>生成 AI の社内導入</h1>
            <p class="subtitle">実戦的 AI 導入完全ガイド</p>
            <p class="author">著：田中 太郎</p>
            <p class="publisher">技術評論社</p>
        </div>
    </header>
    
    <nav class="toc">
        <h2>目次</h2>
        <div class="toc-sections">
            <h3>第 1 部：導入の基礎</h3>
            <ul>
                <li><a href="chapter-01.html">第 1 章：生成 AI 導入の現状と課題</a></li>
                <li><a href="chapter-02.html">第 2 章：抵抗勢力の正体と心理</a></li>
            </ul>
            
            <h3>第 2 部：戦略と実行</h3>
            <ul>
                <li><a href="chapter-03.html">第 3 章：導入戦略の設計</a></li>
                <li><a href="chapter-04.html">第 4 章：パイロットプロジェクトの成功</a></li>
                <li><a href="chapter-05.html">第 5 章：抵抗勢力を味方にするテクニック</a></li>
                <li><a href="chapter-06.html">第 6 章：全社展開と定着</a></li>
            </ul>
            
            <h3>第 3 部：成功と未来</h3>
            <ul>
                <li><a href="chapter-07.html">第 7 章：成功事例と教訓</a></li>
                <li><a href="chapter-08.html">第 8 章：未来への展望</a></li>
            </ul>
            
            <h3>付録</h3>
            <ul>
                <li><a href="appendix/appendix-a.html">付録 A：導入チェックリスト</a></li>
                <li><a href="appendix/appendix-b.html">付録 B：FAQ</a></li>
                <li><a href="appendix/appendix-c.html">付録 C：用語集</a></li>
                <li><a href="appendix/appendix-d.html">付録 D：参考リソース</a></li>
            </ul>
        </div>
    </nav>
    
    <footer>
        <p>&copy; 2025 技術評論社<br>
        ISBN 978-4-12-345678-9</p>
    </footer>
</body>
</html>
```

### chapter-XX.html（各章テンプレート）

```html
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>第 1 章：生成 AI 導入の現状と課題 - 抵抗勢力を黙らせた上で信者にする生成 AI の社内導入</title>
    <link rel="stylesheet" href="../styles/main.css">
</head>
<body>
    <nav class="breadcrumb">
        <a href="../index.html">ホーム</a> &gt; 
        <span>第 1 章</span>
    </nav>
    
    <main>
        <article>
            <h1>第 1 章：生成 AI 導入の現状と課題</h1>
            
            <section>
                <h2>1.1 生成 AI の普及状況</h2>
                <p>本文...</p>
            </section>
            
            <!-- 以下同様 -->
        </article>
    </main>
    
    <nav class="chapter-nav">
        <a href="../index.html" class="prev">← 目次</a>
        <a href="chapter-02.html" class="next">第 2 章 →</a>
    </nav>
    
    <footer>
        <p>&copy; 2025 技術評論社</p>
    </footer>
</body>
</html>
```

---

## EPUB 出力

### 構造

```
book1.epub/
├── mimetype              # 必須（最初、圧縮なし）
├── META-INF/
│   └── container.xml
├── content.opf           # 目次・メタデータ
├── toc.ncx               # 目次（EPUB2）
├── OEBPS/
│   ├── chapter-01.xhtml
│   ├── chapter-02.xhtml
│   ├── ...
│   ├── appendix-a.xhtml
│   ├── ...
│   ├── styles/
│   │   └── main.css
│   └── images/
│       └── ...
```

### content.opf（メタデータ）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookID">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="BookID">urn:uuid:12345678-1234-1234-1234-123456789012</dc:identifier>
        <dc:title>抵抗勢力を黙らせた上で信者にする生成 AI の社内導入</dc:title>
        <dc:creator>田中 太郎</dc:creator>
        <dc:language>ja</dc:language>
        <dc:publisher>技術評論社</dc:publisher>
        <dc:date>2025-01-20</dc:date>
        <dc:rights>© 2025 技術評論社</dc:rights>
        <meta name="calibre:isbn" content="9784123456789"/>
        <meta name="cover" content="cover-image"/>
    </metadata>
    
    <manifest>
        <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg"/>
        <item id="chapter-01" href="chapter-01.xhtml" media-type="application/xhtml+xml"/>
        <item id="chapter-02" href="chapter-02.xhtml" media-type="application/xhtml+xml"/>
        <!-- 以下同様 -->
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="main-css" href="styles/main.css" media-type="text/css"/>
    </manifest>
    
    <spine toc="ncx">
        <itemref idref="cover-image"/>
        <itemref idref="chapter-01"/>
        <itemref idref="chapter-02"/>
        <!-- 以下同様 -->
    </spine>
</package>
```

---

## 変換ツール

### 推奨ツール

| ツール | 用途 | 特徴 |
|-------|-|-----|
| **Pandoc** | Markdown → 各種形式 | オープンソース、多機能 |
| **Calibre** | EPUB/MOBI 変換 | 無料、多機能 |
| **Adobe InDesign** | PDF 出力 | 有料、高品質 |
| **Sigil** | EPUB 編集 | 無料、EPUB 専用 |
| **Kindle Create** | MOBI 変換 | 無料、Kindle 専用 |

### Pandoc 使用例

```bash
# PDF 出力
pandoc book1.md -o book1.pdf --pdf-engine=xelatex

# HTML 出力
pandoc book1.md -o book1.html

# EPUB 出力
pandoc book1.md -o book1.epub

# MOBI 出力（Kindle）
pandoc book1.md -o book1.mobi
```

### Calibre 使用例

```bash
# EPUB → MOBI
ebook-convert book1.epub book1.mobi

# PDF → EPUB
ebook-convert book1.pdf book1.epub
```

---

## 出力チェックリスト

### PDF 出力

- [ ] サイズが正しい（A5）
- [ ] 余白が正しい
- [ ] 文字サイズが正しい
- [ ] 画像が鮮明（300 DPI）
- [ ] カラーモードが正しい（CMYK/sRGB）
- [ ] 目次が機能する
- [ ] ページ番号が正しい
- [ ] 表紙・奥付が含まれている

### HTML 出力

- [ ] レスポンシブデザイン
- [ ] 目次が機能する
- [ ] 内部リンクが機能する
- [ ] 画像が表示される
- [ ] 各種ブラウザで動作確認
- [ ] モバイルで動作確認

### EPUB 出力

- [ ] 目次が機能する
- [ ] 画像が表示される
- [ ] 文字サイズ変更に対応
- [ ] 各種リーダーで動作確認
- [ ] メタデータが正しい

---

## 出力ファイル一覧

### 書籍 1

| フォーマット | ファイル名 | 保存先 |
|------------|-|-----------|
| PDF（印刷用） | book1-print.pdf | output/book/export/ |
| PDF（電子書籍） | book1-ebook.pdf | output/book/export/ |
| HTML（シングル） | book1.html | output/book/export/ |
| HTML（マルチページ） | book1-site/ | output/book/export/ |
| EPUB | book1.epub | output/book/export/ |
| MOBI | book1.mobi | output/book/export/ |

### 書籍 2

| フォーマット | ファイル名 | 保存先 |
|------------|-|-----------|
| PDF（印刷用） | book2-print.pdf | output/book2/export/ |
| PDF（電子書籍） | book2-ebook.pdf | output/book2/export/ |
| HTML（シングル） | book2.html | output/book2/export/ |
| HTML（マルチページ） | book2-site/ | output/book2/export/ |
| EPUB | book2.epub | output/book2/export/ |
| MOBI | book2.mobi | output/book2/export/ |

---

## 出力手順

### 1. Markdown → HTML

```bash
# Pandoc で変換
pandoc toc.md chapter-*.md appendix/*.md -o book1.html \
    --metadata title="抵抗勢力を黙らせた上で信者にする生成 AI の社内導入" \
    --metadata author="田中 太郎" \
    --metadata lang="ja" \
    --css styles/main.css
```

### 2. HTML → PDF

```bash
# Pandoc で PDF 変換
pandoc book1.html -o book1.pdf --pdf-engine=xelatex \
    --variable papersize=a5 \
    --variable geometry="margin=20mm"
```

### 3. HTML → EPUB

```bash
# Pandoc で EPUB 変換
pandoc book1.html -o book1.epub \
    --epub-cover-image images/cover.jpg \
    --metadata title="抵抗勢力を黙らせた上で信者にする生成 AI の社内導入" \
    --metadata author="田中 太郎"
```

### 4. EPUB → MOBI

```bash
# Calibre で MOBI 変換
ebook-convert book1.epub book1.mobi
```

---

## 出力品質確認

### PDF 確認

1. **Adobe Acrobat Reader** で開く
2. 文字が正しく表示されるか確認
3. 画像が鮮明か確認
4. 目次が機能するか確認
5. 印刷プレビューで確認

### HTML 確認

1. **Chrome/Firefox/Safari** で開く
2. レスポンシブデザインが機能するか確認
3. 内部リンクが機能するか確認
4. 画像が表示されるか確認
5. モバイルで確認

### EPUB 確認

1. **Calibre** で開く
2. 目次が機能するか確認
3. 文字サイズ変更が機能するか確認
4. 画像が表示されるか確認
5. Kindle で確認（可能なら）

---

## 出力ファイルの配布

### 印刷出版

- PDF（印刷用）を出版社に提出
- 印刷代行業者に提出

### 電子書籍

- **Kindle**：MOBI/EPUB
- **Apple Books**：EPUB
- **Google Play 書籍**：EPUB
- **楽天 Kobo**：EPUB

### Web 公開

- **公式サイト**：HTML
- **ブログ**：HTML
- **GitHub Pages**：HTML

---

## 出力ファイルの保管

### バージョン管理

```
output/book/export/
├── v1.0/          # 初版
│   ├── book1-print.pdf
│   ├── book1-ebook.pdf
│   ├── book1.html
│   ├── book1-site/
│   ├── book1.epub
│   └── book1.mobi
├── v1.1/          # 修正版
│   └── ...
└── latest/        # 最新版（シンボリックリンク）
    └── ...
```

### ファイル命名規則

```
book1-[フォーマット]-[バージョン].[拡張子]

例：
- book1-print-v1.0.pdf
- book1-ebook-v1.0.pdf
- book1-html-v1.0.html
- book1-epub-v1.0.epub
- book1-mobi-v1.0.mobi
```

---

## 出力コスト目安

| 項目 | 費用 | 備考 |
|-----|------|-----|
| PDF 変換 | 0 円 | Pandoc 無料 |
| HTML 変換 | 0 円 | Pandoc 無料 |
| EPUB 変換 | 0 円 | Pandoc 無料 |
| MOBI 変換 | 0 円 | Calibre 無料 |
| 印刷（100 部） | 30,000 円 | A5、200 ページ |
| ISBN 取得 | 5,500 円 | 1 冊 |
| **合計** | **35,500 円** | 100 部印刷 |

---

## 次のステップ

1. **変換ツールのインストール**
   - Pandoc
   - Calibre
   - LaTeX（PDF 変換用）

2. **変換実行**
   - Markdown → HTML
   - HTML → PDF
   - HTML → EPUB
   - EPUB → MOBI

3. **品質確認**
   - 各形式で確認
   - 印刷プレビュー

4. **配布準備**
   - 各プラットフォームにアップロード
   - 印刷業者への提出

5. **公開**
   - Web サイト公開
   - 書店での販売

---

**ファイル保存先：**
- 書籍 1：`output/book/export/export-format.md`
- 書籍 2：`output/book2/export/export-format.md`

さらに詳細な変換が必要であれば、具体的なご要望をお知らせください。
