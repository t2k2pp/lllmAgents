---
name: markdown-html
description: テキストコンテンツをMarkdownおよびHTMLファイルに変換・保存するスキル。「マークダウンにして」「HTMLにして」「ファイルに保存して」といった要求に応える。コンテンツの構造化、見出し付け、スタイリングも行う。
trigger: /markdown
---

# Markdown & HTML Conversion Skill

## 使い方

ユーザーが「マークダウンにまとめて」「HTMLファイルで保存して」「整形して保存」などを要求した場合に使う。

## Markdown変換手順

1. コンテンツを受け取り、適切な見出し構造を決定する
2. `file_write` でMarkdownファイルを保存する
   - ファイル名は内容を反映したもの（例: `news-2026-03-09.md`）
   - 見出し（# ## ###）で階層化する
   - リスト・テーブルを適切に使う

## HTML変換手順

1. Markdownが既にある場合はそれをベースにする
2. HTMLテンプレートを使って整形する
3. `file_write` でHTMLファイルを保存する
   - ファイル名: `news-2026-03-09.html` など

## HTMLテンプレート（基本）

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>{TITLE}</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.8; }
    h1 { color: #333; border-bottom: 2px solid #333; }
    h2 { color: #555; }
    a { color: #0066cc; }
    blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 15px; color: #666; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f0f0f0; }
  </style>
</head>
<body>
{CONTENT}
</body>
</html>
```

## 注意事項

- 日付はファイル名に含める（`YYYY-MM-DD`形式）
- 出力ディレクトリは指定がなければカレントディレクトリ（`./output/`推奨）
- 保存後はファイルパスをユーザーに報告する
