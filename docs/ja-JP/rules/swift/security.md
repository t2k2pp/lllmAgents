---
paths:
  - "**/*.swift"
  - "**/Package.swift"
---
# Swift セキュリティ

> このファイルは [common/security.md](../common/security.md) を Swift 固有のコンテンツで拡張します。

## シークレット管理

- 機密データ（トークン、パスワード、キー）には **Keychain Services** を使用 — `UserDefaults` は使用しないでください
- ビルド時のシークレットには環境変数または `.xcconfig` ファイルを使用
- ソースコードにシークレットをハードコードしない — 逆コンパイルツールで簡単に抽出されます

```swift
let apiKey = ProcessInfo.processInfo.environment["API_KEY"]
guard let apiKey, !apiKey.isEmpty else {
    fatalError("API_KEY not configured")
}
```

## トランスポートセキュリティ

- App Transport Security（ATS）はデフォルトで強制 — 無効にしないでください
- 重要なエンドポイントには証明書ピンニングを使用
- すべてのサーバー証明書を検証

## 入力検証

- インジェクション防止のため、表示前にすべてのユーザー入力をサニタイズ
- 強制アンラップではなく、検証付きの `URL(string:)` を使用
- 処理前に外部ソース（API、ディープリンク、ペーストボード）からのデータを検証
