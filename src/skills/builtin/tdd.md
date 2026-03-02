---
name: tdd
description: テスト駆動開発ワークフロー
trigger: /tdd
---

# TDD Skill

## When to Use
ユーザーがテスト駆動開発を要求したとき

## How It Works

1. **Red**: まずテストを書く
   - `file_read` で既存のテストコードを確認
   - `file_write` でテストファイルを作成/更新
   - `bash` でテストを実行し、失敗を確認

2. **Green**: テストを通す最小限のコードを書く
   - `file_write` / `file_edit` で実装コードを作成
   - `bash` でテストを実行し、成功を確認

3. **Refactor**: コードを改善する
   - 重複の排除
   - 命名の改善
   - `bash` でテストを実行し、リグレッションがないことを確認

## Rules
- テストを先に書く（Red-Green-Refactor サイクル）
- 一度に1つの機能に集中する
- テストが通るまで次の機能に進まない
- リファクタリング後は必ずテストを再実行する
