---
name: swift-protocol-di-testing
description: Protocol-based dependency injection for testable Swift code — mock file system, network, and external APIs using focused protocols and Swift Testing.
origin: ECC
---

# Swift プロトコルベースの依存性注入によるテスト

外部依存関係（ファイルシステム、ネットワーク、iCloud）を小さく焦点を絞ったプロトコルの背後に抽象化することで、Swift コードをテスト可能にするためのパターン集です。I/O なしで決定論的なテストを可能にします。

## 有効化するタイミング

- ファイルシステム、ネットワーク、外部 API にアクセスする Swift コードを書く場合
- 実際の障害を発生させずにエラーハンドリングパスをテストする必要がある場合
- 複数の環境（アプリ、テスト、SwiftUI プレビュー）で動作するモジュールを構築する場合
- Swift Concurrency（Actor、Sendable）を使用したテスト可能なアーキテクチャを設計する場合

## コアパターン

### 1. 小さく焦点を絞ったプロトコルの定義

各プロトコルは一つの外部関心事のみを処理します。

```swift
// ファイルシステムアクセス
public protocol FileSystemProviding: Sendable {
    func containerURL(for purpose: Purpose) -> URL?
}

// ファイル読み書き操作
public protocol FileAccessorProviding: Sendable {
    func read(from url: URL) throws -> Data
    func write(_ data: Data, to url: URL) throws
    func fileExists(at url: URL) -> Bool
}

// ブックマークストレージ（例：サンドボックス化されたアプリ用）
public protocol BookmarkStorageProviding: Sendable {
    func saveBookmark(_ data: Data, for key: String) throws
    func loadBookmark(for key: String) throws -> Data?
}
```

### 2. デフォルト（本番）実装の作成

```swift
public struct DefaultFileSystemProvider: FileSystemProviding {
    public init() {}

    public func containerURL(for purpose: Purpose) -> URL? {
        FileManager.default.url(forUbiquityContainerIdentifier: nil)
    }
}

public struct DefaultFileAccessor: FileAccessorProviding {
    public init() {}

    public func read(from url: URL) throws -> Data {
        try Data(contentsOf: url)
    }

    public func write(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
    }

    public func fileExists(at url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }
}
```

### 3. テスト用のモック実装の作成

```swift
public final class MockFileAccessor: FileAccessorProviding, @unchecked Sendable {
    public var files: [URL: Data] = [:]
    public var readError: Error?
    public var writeError: Error?

    public init() {}

    public func read(from url: URL) throws -> Data {
        if let error = readError { throw error }
        guard let data = files[url] else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        return data
    }

    public func write(_ data: Data, to url: URL) throws {
        if let error = writeError { throw error }
        files[url] = data
    }

    public func fileExists(at url: URL) -> Bool {
        files[url] != nil
    }
}
```

### 4. デフォルトパラメータによる依存性の注入

本番コードはデフォルトを使用し、テストのみがモックを注入します。

```swift
public actor SyncManager {
    private let fileSystem: FileSystemProviding
    private let fileAccessor: FileAccessorProviding

    public init(
        fileSystem: FileSystemProviding = DefaultFileSystemProvider(),
        fileAccessor: FileAccessorProviding = DefaultFileAccessor()
    ) {
        self.fileSystem = fileSystem
        self.fileAccessor = fileAccessor
    }

    public func sync() async throws {
        guard let containerURL = fileSystem.containerURL(for: .sync) else {
            throw SyncError.containerNotAvailable
        }
        let data = try fileAccessor.read(
            from: containerURL.appendingPathComponent("data.json")
        )
        // データを処理...
    }
}
```

### 5. Swift Testing でテストを書く

```swift
import Testing

@Test("Sync manager handles missing container")
func testMissingContainer() async {
    let mockFileSystem = MockFileSystemProvider(containerURL: nil)
    let manager = SyncManager(fileSystem: mockFileSystem)

    await #expect(throws: SyncError.containerNotAvailable) {
        try await manager.sync()
    }
}

@Test("Sync manager reads data correctly")
func testReadData() async throws {
    let mockFileAccessor = MockFileAccessor()
    mockFileAccessor.files[testURL] = testData

    let manager = SyncManager(fileAccessor: mockFileAccessor)
    let result = try await manager.loadData()

    #expect(result == expectedData)
}

@Test("Sync manager handles read errors gracefully")
func testReadError() async {
    let mockFileAccessor = MockFileAccessor()
    mockFileAccessor.readError = CocoaError(.fileReadCorruptFile)

    let manager = SyncManager(fileAccessor: mockFileAccessor)

    await #expect(throws: SyncError.self) {
        try await manager.sync()
    }
}
```

## ベストプラクティス

- **単一責任**：各プロトコルは一つの関心事を処理する -- 多くのメソッドを持つ「ゴッドプロトコル」を作らない
- **Sendable 準拠**：プロトコルが Actor 境界を越えて使用される場合は必須
- **デフォルトパラメータ**：本番コードはデフォルトで実装を使用し、テストのみがモックを指定する
- **エラーシミュレーション**：障害パスのテストのために、設定可能なエラープロパティを持つモックを設計する
- **境界のみをモック**：外部依存関係（ファイルシステム、ネットワーク、API）をモックし、内部型はモックしない

## 避けるべきアンチパターン

- すべての外部アクセスをカバーする単一の大きなプロトコルを作成する
- 外部依存関係を持たない内部型をモックする
- 適切な依存性注入の代わりに `#if DEBUG` 条件分岐を使用する
- Actor で使用する際に `Sendable` 準拠を忘れる
- 過剰設計：外部依存関係がない型にはプロトコルは不要

## 使用するタイミング

- ファイルシステム、ネットワーク、外部 API にアクセスする Swift コード全般
- 実際の環境では発生させにくいエラーハンドリングパスのテスト
- アプリ、テスト、SwiftUI プレビューの各コンテキストで動作する必要があるモジュールの構築
- テスト可能なアーキテクチャが必要な Swift Concurrency（Actor、構造化並行性）を使用するアプリ
