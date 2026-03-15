---
name: code-stats
description: コードベースの統計情報を収集して報告する。ファイル数、行数、言語分布など。context:fork で独立したコンテキストで実行される。
context: fork
tools: [bash, glob, grep, file_read]
---

# Code Stats Skill

コードベースの統計情報を調査して報告します。

## 実行内容

1. `bash` で `find` や `wc -l` を使ってファイル数・行数を集計
2. `glob` で言語別ファイルリストを取得
3. `bash` で `git log --shortstat` から最近の変更傾向を確認
4. 結果を表形式でまとめる

## Output Format

```
## コードベース統計

### ファイル数
| 言語 | ファイル数 | 総行数 |
|------|-----------|--------|
| TypeScript | N | N |
| Markdown | N | N |

### 最近のアクティビティ (直近10コミット)
- 追加行数: N
- 削除行数: N

### サマリー
- 総ファイル数: N
- 総行数: N
- 主要言語: XXX
```
