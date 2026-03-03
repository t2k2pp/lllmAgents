---
paths:
  - "**/*.swift"
  - "**/Package.swift"
---
# Swift Hooks

> このファイルは [common/hooks.md](../common/hooks.md) を Swift 固有のコンテンツで拡張します。

## PostToolUse Hooks

`~/.claude/settings.json` で設定:

- **SwiftFormat**: 編集後に `.swift` ファイルを自動フォーマット
- **SwiftLint**: `.swift` ファイル編集後にリントチェックを実行
- **swift build**: 編集後に変更されたパッケージの型チェック

## 警告

`print()` 文にフラグを立てる — 本番コードでは `os.Logger` または構造化ロギングを代わりに使用してください。
