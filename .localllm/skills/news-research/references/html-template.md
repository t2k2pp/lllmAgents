# HTML出力テンプレート

ニュースをHTMLで出力する際は以下のテンプレートを使用してください。

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ニュースまとめ - YYYY年MM月DD日</title>
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #f5f5f5; color: #333; }
    h1 { border-bottom: 3px solid #0066cc; padding-bottom: 10px; color: #0066cc; }
    h2 { color: #444; margin-top: 30px; }
    .news-card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .news-card h3 { margin-top: 0; color: #222; }
    .news-meta { color: #888; font-size: 0.9em; margin-top: 10px; }
    .news-source a { color: #0066cc; text-decoration: none; }
    .news-source a:hover { text-decoration: underline; }
    .category-tag { display: inline-block; background: #0066cc; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; margin-bottom: 10px; }
  </style>
</head>
<body>
  <h1>📰 ニュースまとめ</h1>
  <p class="news-meta">収集日時: YYYY年MM月DD日 HH:MM</p>

  <h2>主要ニュース</h2>

  <div class="news-card">
    <span class="category-tag">カテゴリ</span>
    <h3>記事タイトル</h3>
    <p>記事の概要テキスト...</p>
    <div class="news-meta">
      <span>📅 記事日時</span>
      <span class="news-source"> | 出典: <a href="URL" target="_blank">サイト名</a></span>
    </div>
  </div>

</body>
</html>
```
