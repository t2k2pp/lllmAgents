---
name: swift-actor-persistence
description: Thread-safe data persistence in Swift using actors — in-memory cache with file-backed storage, eliminating data races by design.
origin: ECC
---

# Swift Actor によるスレッドセーフな永続化

Swift の Actor を使用してスレッドセーフなデータ永続化レイヤーを構築するためのパターン集です。インメモリキャッシュとファイルバックドストレージを組み合わせ、Actor モデルを活用してコンパイル時にデータ競合を排除します。

## 有効化するタイミング

- Swift 5.5+ でデータ永続化レイヤーを構築する場合
- 共有可変状態へのスレッドセーフなアクセスが必要な場合
- 手動の同期（ロック、DispatchQueue）を排除したい場合
- ローカルストレージを持つオフラインファーストアプリを構築する場合

## コアパターン

### Actor ベースのリポジトリ

Actor モデルはシリアライズされたアクセスを保証します。データ競合なし、コンパイラによる強制です。

```swift
public actor LocalRepository<T: Codable & Identifiable> where T.ID == String {
    private var cache: [String: T] = [:]
    private let fileURL: URL

    public init(directory: URL = .documentsDirectory, filename: String = "data.json") {
        self.fileURL = directory.appendingPathComponent(filename)
        // init 中の同期読み込み（Actor 分離はまだアクティブでない）
        self.cache = Self.loadSynchronously(from: fileURL)
    }

    // MARK: - Public API

    public func save(_ item: T) throws {
        cache[item.id] = item
        try persistToFile()
    }

    public func delete(_ id: String) throws {
        cache[id] = nil
        try persistToFile()
    }

    public func find(by id: String) -> T? {
        cache[id]
    }

    public func loadAll() -> [T] {
        Array(cache.values)
    }

    // MARK: - Private

    private func persistToFile() throws {
        let data = try JSONEncoder().encode(Array(cache.values))
        try data.write(to: fileURL, options: .atomic)
    }

    private static func loadSynchronously(from url: URL) -> [String: T] {
        guard let data = try? Data(contentsOf: url),
              let items = try? JSONDecoder().decode([T].self, from: data) else {
            return [:]
        }
        return Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
    }
}
```

### 使い方

Actor 分離により、すべての呼び出しは自動的に async になります：

```swift
let repository = LocalRepository<Question>()

// 読み取り -- インメモリキャッシュからの高速 O(1) ルックアップ
let question = await repository.find(by: "q-001")
let allQuestions = await repository.loadAll()

// 書き込み -- キャッシュを更新し、ファイルにアトミックに永続化
try await repository.save(newQuestion)
try await repository.delete("q-001")
```

### @Observable ViewModel との組み合わせ

```swift
@Observable
final class QuestionListViewModel {
    private(set) var questions: [Question] = []
    private let repository: LocalRepository<Question>

    init(repository: LocalRepository<Question> = LocalRepository()) {
        self.repository = repository
    }

    func load() async {
        questions = await repository.loadAll()
    }

    func add(_ question: Question) async throws {
        try await repository.save(question)
        questions = await repository.loadAll()
    }
}
```

## 主要な設計判断

| 判断 | 根拠 |
|------|------|
| Actor（class + lock ではなく） | コンパイラによるスレッドセーフティの強制、手動同期不要 |
| インメモリキャッシュ + ファイル永続化 | キャッシュからの高速読み取り、ディスクへの耐久的な書き込み |
| init での同期読み込み | 非同期初期化の複雑さを回避 |
| ID をキーとした Dictionary | 識別子による O(1) ルックアップ |
| `Codable & Identifiable` に対するジェネリック | 任意のモデル型で再利用可能 |
| アトミックファイル書き込み（`.atomic`） | クラッシュ時の部分書き込みを防止 |

## ベストプラクティス

- Actor 境界を越えるすべてのデータに **`Sendable` 型を使用**する
- **Actor の公開 API を最小限に保つ** -- 永続化の詳細ではなく、ドメイン操作のみを公開する
- データ破損を防ぐために **`.atomic` 書き込みを使用**する
- **`init` で同期的に読み込む** -- ローカルファイルに対しては、非同期イニシャライザは複雑さを増すだけで利点が少ない
- リアクティブな UI 更新のために **`@Observable` ViewModel と組み合わせる**

## 避けるべきアンチパターン

- 新しい Swift Concurrency コードで Actor の代わりに `DispatchQueue` や `NSLock` を使用する
- 内部のキャッシュ Dictionary を外部の呼び出し元に公開する
- バリデーションなしでファイル URL を設定可能にする
- すべての Actor メソッド呼び出しが `await` であることを忘れる -- 呼び出し元は非同期コンテキストを処理する必要がある
- Actor 分離をバイパスするために `nonisolated` を使用する（目的を損なう）

## 使用するタイミング

- iOS/macOS アプリのローカルデータストレージ（ユーザーデータ、設定、キャッシュコンテンツ）
- 後でサーバーと同期するオフラインファーストアーキテクチャ
- アプリの複数の部分が並行してアクセスする共有可変状態
- レガシーの `DispatchQueue` ベースのスレッドセーフティをモダンな Swift Concurrency に置き換える場合
