---
name: pr-review
description: Pull Request のコードレビュー
trigger: /pr-review
---

# PR Review Skill

## When to Use
ユーザーがコードレビューを要求したとき

## How It Works

1. `bash` で `git diff main...HEAD` (または適切なベースブランチ)を実行
2. 変更されたファイルを `file_read` で読む
3. 以下の観点でレビュー:
   - バグや論理エラー
   - セキュリティ脆弱性
   - パフォーマンス問題
   - コーディングスタイルの一貫性
   - テストの有無
   - エッジケースの処理
4. 問題点と改善提案をまとめて報告

## Output Format
```
## レビュー結果

### 重要度: 高
- [ファイル:行] 問題の説明

### 重要度: 中
- [ファイル:行] 問題の説明

### 改善提案
- 提案内容
```
