---
name: demo-skill
description: LocalLLMのスキル読込、UTF-8表示、同梱リソース参照を診断する。ユーザーがdemo-skillを明示的に実行した場合、または開発者がスキル機構のsmoke testを求めた場合だけ使用する。
---

# Demo Skill

スキルローダーとUTF-8資産の配布を診断するための、意図的に小さい組込みfixture。

## 実行手順

1. `references/expected-output.md` をUTF-8で読む。
2. `scripts/diagnose.mjs` を実行できる環境なら実行する。
3. 出力の `skill`、`utf8`、`resource` が期待値と一致するか確認する。
4. ユーザーには診断結果だけを簡潔に返し、ファイルを変更しない。

## 制約

- 通常の開発依頼では自動起動しない。
- APIキー、token、環境変数の値を出力しない。
- 失敗時は文字化けした内容を推測せず、失敗したファイルと文字コード検査結果を示す。
