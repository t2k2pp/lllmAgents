---
paths:
  - "**/*.go"
  - "**/go.mod"
  - "**/go.sum"
---
# Go テスト

> このファイルは [common/testing.md](../common/testing.md) を Go 固有のコンテンツで拡張します。

## フレームワーク

標準の `go test` を **テーブル駆動テスト** と共に使用してください。

## 競合検出

常に `-race` フラグを付けて実行してください:

```bash
go test -race ./...
```

## カバレッジ

```bash
go test -cover ./...
```

## 参照

スキル: `golang-testing` で詳細な Go テストパターンとヘルパーを参照してください。
