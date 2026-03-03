---
paths:
  - "**/*.swift"
  - "**/Package.swift"
---
# Swift コーディングスタイル

> このファイルは [common/coding-style.md](../common/coding-style.md) を Swift 固有のコンテンツで拡張します。

## フォーマット

- 自動フォーマットに **SwiftFormat**、スタイル強制に **SwiftLint** を使用
- `swift-format` は Xcode 16+ に代替として同梱

## 不変性

- `var` より `let` を優先 — すべてを `let` で定義し、コンパイラが要求する場合のみ `var` に変更
- デフォルトで値セマンティクスを持つ `struct` を使用。アイデンティティまたは参照セマンティクスが必要な場合のみ `class` を使用

## 命名

[Apple API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/) に従ってください:

- 使用箇所での明確さ — 不要な言葉を省く
- メソッドとプロパティは型ではなく、役割で命名
- グローバル定数よりも `static let` を定数に使用

## エラーハンドリング

型付き throws（Swift 6+）とパターンマッチングを使用してください:

```swift
func load(id: String) throws(LoadError) -> Item {
    guard let data = try? read(from: path) else {
        throw .fileNotFound(id)
    }
    return try decode(data)
}
```

## 並行処理

Swift 6 の厳格な並行処理チェックを有効にしてください。以下を優先:

- 分離境界を越えるデータには `Sendable` 値型
- 共有可変状態にはアクター
- 非構造化 `Task {}` よりも構造化された並行処理（`async let`、`TaskGroup`）
