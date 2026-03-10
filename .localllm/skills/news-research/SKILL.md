---
name: news-research
description: 最新ニュースの調査・収集・要約を行うスキル。「今日のニュース」「昨日のニュース」「〇〇に関するニュース」のような要求を受けたとき、web_searchとweb_fetchを使って複数の情報源からニュースを収集し、整理してまとめる。マークダウンやHTMLでの出力もサポートする。
trigger: /news
---

# News Research Skill

## 手順

1. **検索フェーズ**: `web_search`を使って対象トピックのニュースを検索する
   - 例: `"今日 ニュース 2026"`, `"site:nhk.or.jp OR site:nikkei.com ニュース"`
   - 英語ニュースも必要であれば `"latest news today 2026"` で検索
   - 複数クエリで幅広く収集する（最低3クエリ）

2. **詳細取得フェーズ**: 重要そうな記事URLに対して `web_fetch` で内容を取得する
   - 上位3〜5記事を取得
   - タイトル・本文・日時を抽出する

3. **整理フェーズ**: 収集した情報をカテゴリ別に整理する
   - 国内ニュース / 国際ニュース / 経済 / テクノロジー / スポーツ など

4. **出力フェーズ**: 要求された形式で出力する
   - Markdown形式（デフォルト）
   - HTML形式（要求された場合）
   - 出典URLを必ず含める

## 信頼性の高いニュースソース

- NHK: https://www3.nhk.or.jp/news/
- 日経: https://www.nikkei.com/
- 朝日新聞: https://www.asahi.com/
- BBC Japan: https://www.bbc.com/japanese
- Reuters日本語: https://jp.reuters.com/

## 生成AIのニュースソース

- ChatGPT: https://openai.com/ja-JP/news/
- Claude: https://www.anthropic.com/news
- Gemini: https://ai.google.dev/gemini/news

## 研修・イベントニュースソース

- Connpass: https://connpass.com/explore/
- Connpass Atom: https://connpass.com/explore/ja.atom

## 出力テンプレート (Markdown)

```markdown
# ニュースまとめ - YYYY年MM月DD日

## 主要ニュース

### 1. [タイトル]
**概要**: [1〜3行の要約]
**出典**: [URL]
**日時**: [記事の日時]

### 2. [タイトル]
...
```

## 出力テンプレート (HTML)

HTMLで出力する場合は `references/html-template.md` を参照してください。
