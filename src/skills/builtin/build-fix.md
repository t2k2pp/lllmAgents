---
name: build-fix
description: ビルドエラーを診断して修正する
trigger: /build-fix
---

# Build Fix Skill

## When to Use
ユーザーがビルドエラーの修正を要求したとき

## How It Works

1. `bash` でビルドコマンドを実行しエラーを確認
   - npm/pnpm/yarn/bun でのビルド
   - TypeScript コンパイルエラー
   - その他のビルドツール
2. エラーメッセージを分析
3. `file_read` でエラーが発生しているファイルを読む
4. `grep` で関連するコードを検索
5. `file_edit` で修正を適用
6. `bash` で再ビルドして修正を確認
7. 修正が成功するまで繰り返す

## Rules
- エラーメッセージを正確に読む
- 1つずつエラーを修正する
- 修正後は必ず再ビルドで確認する
- 不要なコードの追加を避ける
