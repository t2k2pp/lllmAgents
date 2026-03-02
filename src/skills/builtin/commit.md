---
name: commit
description: Git commit workflow - 変更を確認してコミットメッセージを生成する
trigger: /commit
---

# Commit Skill

## When to Use
ユーザーがgitコミットを要求したとき

## How It Works

1. `bash` で `git status` を実行し、変更を確認
2. `bash` で `git diff --stat` と `git diff` を実行し、差分を確認
3. `bash` で `git log --oneline -5` を実行し、直近のコミットスタイルを確認
4. 変更内容を分析し、適切なコミットメッセージを生成
5. ユーザーにコミットメッセージを提示して確認を取る
6. `bash` で `git add` と `git commit` を実行

## Rules
- .env, credentials等の機密ファイルをコミットしない
- コミットメッセージは簡潔に（1-2文）
- プッシュはユーザーの明示的な指示がない限り行わない
- pre-commit hookが失敗した場合は--amendではなく新しいコミットを作る
