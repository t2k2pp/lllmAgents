---
name: pr-review
description: Pull Requestのコードレビュー。ユーザーがPRレビュー、コードレビュー、変更のレビュー、またはプルリクエストの確認を要求したときに使用する。
context: fork
tools: [bash, file_read, glob, grep]
---

# PR Review Skill

## 手順

1. **差分取得**: `bash` で `git diff main...HEAD` (または適切なベースブランチ) を実行
2. **変更ファイル精読**: `file_read` で各変更ファイルを読み、 必要に応じて grep で関連箇所を確認
3. **観点に従ってレビュー**: `../code-review/references/code-review-criteria.md` の重要度分類・チェック観点・出力形式に従う (PR レビューでは特に「テストの追加・更新」「破壊的変更の有無」 を重視)
4. **報告**: 重要度の高い順にまとめる

## PR レビュー特有の観点 (共通観点に追加)

- 変更スコープが PR のタイトル・説明と一致しているか
- 関連テストが追加・更新されているか
- マイグレーション / 破壊的変更があれば明記されているか
- リファクタリングと機能追加が混在していないか

詳細な観点・形式は共通リファレンス **`../code-review/references/code-review-criteria.md`** を参照すること。
