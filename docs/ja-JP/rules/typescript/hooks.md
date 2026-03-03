---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---
# TypeScript/JavaScript Hooks

> このファイルは [common/hooks.md](../common/hooks.md) を TypeScript/JavaScript 固有のコンテンツで拡張します。

## PostToolUse Hooks

`~/.claude/settings.json` で設定:

- **Prettier**: 編集後に JS/TS ファイルを自動フォーマット
- **TypeScript チェック**: `.ts`/`.tsx` ファイル編集後に `tsc` を実行
- **console.log 警告**: 編集されたファイル内の `console.log` について警告

## Stop Hooks

- **console.log 監査**: セッション終了前にすべての変更ファイルで `console.log` をチェック
