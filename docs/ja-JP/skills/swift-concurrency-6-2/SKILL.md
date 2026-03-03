---
name: swift-concurrency-6-2
description: Swift 6.2 Approachable Concurrency — single-threaded by default, @concurrent for explicit background offloading, isolated conformances for main actor types.
---

# Swift 6.2 Approachable Concurrency

Swift 6.2 の並行性モデルを採用するためのパターン集です。コードはデフォルトでシングルスレッドで実行され、並行性は明示的に導入されます。パフォーマンスを犠牲にすることなく、一般的なデータ競合エラーを排除します。

## 有効化するタイミング

- Swift 5.x または 6.0/6.1 プロジェクトを Swift 6.2 に移行する場合
- データ競合安全性のコンパイラエラーを解決する場合
- MainActor ベースのアプリアーキテクチャを設計する場合
- CPU 負荷の高い処理をバックグラウンドスレッドにオフロードする場合
- MainActor で分離された型のプロトコル準拠を実装する場合
- Xcode 26 で Approachable Concurrency ビルド設定を有効にする場合

## コアの問題：暗黙的なバックグラウンドオフロード

Swift 6.1 以前では、非同期関数は暗黙的にバックグラウンドスレッドにオフロードされる可能性があり、一見安全に見えるコードでもデータ競合エラーが発生していました：

```swift
// Swift 6.1: ERROR
@MainActor
final class StickerModel {
    let photoProcessor = PhotoProcessor()

    func extractSticker(_ item: PhotosPickerItem) async throws -> Sticker? {
        guard let data = try await item.loadTransferable(type: Data.self) else { return nil }

        // Error: Sending 'self.photoProcessor' risks causing data races
        return await photoProcessor.extractSticker(data: data, with: item.itemIdentifier)
    }
}
```

Swift 6.2 ではこれが修正されます：非同期関数はデフォルトで呼び出し元の Actor 上にとどまります。

```swift
// Swift 6.2: OK — async は MainActor 上にとどまり、データ競合なし
@MainActor
final class StickerModel {
    let photoProcessor = PhotoProcessor()

    func extractSticker(_ item: PhotosPickerItem) async throws -> Sticker? {
        guard let data = try await item.loadTransferable(type: Data.self) else { return nil }
        return await photoProcessor.extractSticker(data: data, with: item.itemIdentifier)
    }
}
```

## コアパターン -- Isolated Conformances

MainActor 型が非分離プロトコルに安全に準拠できるようになりました：

```swift
protocol Exportable {
    func export()
}

// Swift 6.1: ERROR — main actor で分離されたコードへの越境
// Swift 6.2: OK（isolated conformance を使用）
extension StickerModel: @MainActor Exportable {
    func export() {
        photoProcessor.exportAsPNG()
    }
}
```

コンパイラは準拠が main actor 上でのみ使用されることを保証します：

```swift
// OK — ImageExporter も @MainActor
@MainActor
struct ImageExporter {
    var items: [any Exportable]

    mutating func add(_ item: StickerModel) {
        items.append(item)  // 安全：同じ actor 分離
    }
}

// ERROR — nonisolated コンテキストは MainActor の conformance を使用できない
nonisolated struct ImageExporter {
    var items: [any Exportable]

    mutating func add(_ item: StickerModel) {
        items.append(item)  // Error: Main actor-isolated conformance cannot be used here
    }
}
```

## コアパターン -- グローバル変数と静的変数

グローバル/静的状態を MainActor で保護します：

```swift
// Swift 6.1: ERROR — non-Sendable 型が共有可変状態を持つ可能性
final class StickerLibrary {
    static let shared: StickerLibrary = .init()  // Error
}

// 修正：@MainActor でアノテート
@MainActor
final class StickerLibrary {
    static let shared: StickerLibrary = .init()  // OK
}
```

### MainActor デフォルト推論モード

Swift 6.2 では、MainActor がデフォルトで推論されるモードが導入されます。手動のアノテーションが不要になります：

```swift
// MainActor デフォルト推論を有効にした場合：
final class StickerLibrary {
    static let shared: StickerLibrary = .init()  // 暗黙的に @MainActor
}

final class StickerModel {
    let photoProcessor: PhotoProcessor
    var selection: [PhotosPickerItem]  // 暗黙的に @MainActor
}

extension StickerModel: Exportable {  // 暗黙的に @MainActor conformance
    func export() {
        photoProcessor.exportAsPNG()
    }
}
```

このモードはオプトインであり、アプリ、スクリプト、その他の実行可能ターゲットに推奨されます。

## コアパターン -- バックグラウンド処理のための @concurrent

実際の並列処理が必要な場合は、`@concurrent` で明示的にオフロードします：

> **重要：** この例は Approachable Concurrency ビルド設定（SE-0466（MainActor デフォルト分離）と SE-0461（NonisolatedNonsendingByDefault））が必要です。これらが有効な場合、`extractSticker` は呼び出し元の Actor 上にとどまり、可変状態へのアクセスが安全になります。**これらの設定がない場合、このコードにはデータ競合があります** -- コンパイラがフラグを立てます。

```swift
nonisolated final class PhotoProcessor {
    private var cachedStickers: [String: Sticker] = [:]

    func extractSticker(data: Data, with id: String) async -> Sticker {
        if let sticker = cachedStickers[id] {
            return sticker
        }

        let sticker = await Self.extractSubject(from: data)
        cachedStickers[id] = sticker
        return sticker
    }

    // 高コストな処理を並行スレッドプールにオフロード
    @concurrent
    static func extractSubject(from data: Data) async -> Sticker { /* ... */ }
}

// 呼び出し元は await が必要
let processor = PhotoProcessor()
processedPhotos[item.id] = await processor.extractSticker(data: data, with: item.id)
```

`@concurrent` の使い方：
1. 含まれる型を `nonisolated` にマーク
2. 関数に `@concurrent` を追加
3. まだ非同期でなければ `async` を追加
4. 呼び出しサイトに `await` を追加

## 主要な設計判断

| 判断 | 根拠 |
|------|------|
| デフォルトでシングルスレッド | 最も自然なコードがデータ競合フリー。並行性はオプトイン |
| async は呼び出し元の Actor 上にとどまる | データ競合エラーの原因だった暗黙的なオフロードを排除 |
| Isolated conformances | MainActor 型が安全でないワークアラウンドなしでプロトコルに準拠可能 |
| `@concurrent` の明示的オプトイン | バックグラウンド実行は偶発的ではなく、意図的なパフォーマンス選択 |
| MainActor デフォルト推論 | アプリターゲットのボイラープレート `@MainActor` アノテーションを削減 |
| オプトイン採用 | 破壊的でない移行パス -- 機能を段階的に有効化 |

## 移行ステップ

1. **Xcode で有効化**：Build Settings の Swift Compiler > Concurrency セクション
2. **SPM で有効化**：Package manifest の `SwiftSettings` API を使用
3. **移行ツールの使用**：swift.org/migration による自動コード変更
4. **MainActor デフォルトから開始**：アプリターゲットの推論モードを有効化
5. **必要な箇所に `@concurrent` を追加**：まずプロファイルし、ホットパスをオフロード
6. **徹底的にテスト**：データ競合の問題がコンパイル時エラーになる

## ベストプラクティス

- **MainActor から開始** -- まずシングルスレッドのコードを書き、後で最適化
- **`@concurrent` は CPU 負荷の高い処理にのみ使用** -- 画像処理、圧縮、複雑な計算
- 主にシングルスレッドのアプリターゲットには **MainActor 推論モードを有効化**
- **オフロード前にプロファイル** -- Instruments で実際のボトルネックを見つける
- **グローバル変数は MainActor で保護** -- グローバル/静的な可変状態には Actor 分離が必要
- `nonisolated` ワークアラウンドや `@Sendable` ラッパーの代わりに **isolated conformances を使用**
- **段階的に移行** -- ビルド設定で機能を一つずつ有効化

## 避けるべきアンチパターン

- すべての async 関数に `@concurrent` を適用する（ほとんどはバックグラウンド実行不要）
- 分離を理解せずにコンパイラエラーを抑制するために `nonisolated` を使用する
- Actor が同じ安全性を提供するのにレガシーの `DispatchQueue` パターンを維持する
- 並行性関連の Foundation Models コードで `model.availability` チェックをスキップする
- コンパイラと戦う -- データ競合を報告している場合、コードに実際の並行性の問題がある
- すべての async コードがバックグラウンドで実行されると仮定する（Swift 6.2 デフォルト：呼び出し元の Actor 上にとどまる）

## 使用するタイミング

- すべての新しい Swift 6.2+ プロジェクト（Approachable Concurrency が推奨デフォルト）
- Swift 5.x または 6.0/6.1 の並行性からの既存アプリの移行
- Xcode 26 採用時のデータ競合安全性コンパイラエラーの解決
- MainActor 中心のアプリアーキテクチャの構築（ほとんどの UI アプリ）
- パフォーマンス最適化 -- 特定の重い計算処理のバックグラウンドへのオフロード
