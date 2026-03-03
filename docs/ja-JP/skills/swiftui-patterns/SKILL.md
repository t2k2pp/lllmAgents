---
name: swiftui-patterns
description: SwiftUI architecture patterns, state management with @Observable, view composition, navigation, performance optimization, and modern iOS/macOS UI best practices.
---

# SwiftUI パターン

Apple プラットフォーム上で宣言的かつ高パフォーマンスなユーザーインターフェースを構築するためのモダンな SwiftUI パターン集です。Observation フレームワーク、ビュー構成、型安全なナビゲーション、パフォーマンス最適化をカバーしています。

## 有効化するタイミング

- SwiftUI ビューの構築と状態管理（`@State`、`@Observable`、`@Binding`）
- `NavigationStack` を使用したナビゲーションフローの設計
- ViewModel とデータフローの構造化
- リストや複雑なレイアウトのレンダリングパフォーマンスの最適化
- SwiftUI での環境値と依存性注入の操作

## 状態管理

### プロパティラッパーの選択

最もシンプルな適切なラッパーを選びます：

| ラッパー | ユースケース |
|---------|------------|
| `@State` | ビューローカルな値型（トグル、フォームフィールド、シート表示） |
| `@Binding` | 親の `@State` への双方向参照 |
| `@Observable` class + `@State` | 複数のプロパティを持つ所有モデル |
| `@Observable` class（ラッパーなし） | 親から渡された読み取り専用の参照 |
| `@Bindable` | `@Observable` プロパティへの双方向バインディング |
| `@Environment` | `.environment()` で注入された共有依存関係 |

### @Observable ViewModel

`@Observable`（`ObservableObject` ではなく）を使用します。プロパティレベルの変更を追跡するため、SwiftUI は変更されたプロパティを読み取るビューのみを再レンダリングします：

```swift
@Observable
final class ItemListViewModel {
    private(set) var items: [Item] = []
    private(set) var isLoading = false
    var searchText = ""

    private let repository: any ItemRepository

    init(repository: any ItemRepository = DefaultItemRepository()) {
        self.repository = repository
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        items = (try? await repository.fetchAll()) ?? []
    }
}
```

### ViewModel を使用するビュー

```swift
struct ItemListView: View {
    @State private var viewModel: ItemListViewModel

    init(viewModel: ItemListViewModel = ItemListViewModel()) {
        _viewModel = State(initialValue: viewModel)
    }

    var body: some View {
        List(viewModel.items) { item in
            ItemRow(item: item)
        }
        .searchable(text: $viewModel.searchText)
        .overlay { if viewModel.isLoading { ProgressView() } }
        .task { await viewModel.load() }
    }
}
```

### Environment による注入

`@EnvironmentObject` の代わりに `@Environment` を使用します：

```swift
// 注入
ContentView()
    .environment(authManager)

// 使用
struct ProfileView: View {
    @Environment(AuthManager.self) private var auth

    var body: some View {
        Text(auth.currentUser?.name ?? "Guest")
    }
}
```

## ビュー構成

### サブビューを抽出して無効化を制限する

ビューを小さく焦点を絞った構造体に分割します。状態が変わった場合、その状態を読み取るサブビューのみが再レンダリングされます：

```swift
struct OrderView: View {
    @State private var viewModel = OrderViewModel()

    var body: some View {
        VStack {
            OrderHeader(title: viewModel.title)
            OrderItemList(items: viewModel.items)
            OrderTotal(total: viewModel.total)
        }
    }
}
```

### 再利用可能なスタイルのための ViewModifier

```swift
struct CardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding()
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

extension View {
    func cardStyle() -> some View {
        modifier(CardModifier())
    }
}
```

## ナビゲーション

### 型安全な NavigationStack

プログラム的で型安全なルーティングのために `NavigationStack` と `NavigationPath` を使用します：

```swift
@Observable
final class Router {
    var path = NavigationPath()

    func navigate(to destination: Destination) {
        path.append(destination)
    }

    func popToRoot() {
        path = NavigationPath()
    }
}

enum Destination: Hashable {
    case detail(Item.ID)
    case settings
    case profile(User.ID)
}

struct RootView: View {
    @State private var router = Router()

    var body: some View {
        NavigationStack(path: $router.path) {
            HomeView()
                .navigationDestination(for: Destination.self) { dest in
                    switch dest {
                    case .detail(let id): ItemDetailView(itemID: id)
                    case .settings: SettingsView()
                    case .profile(let id): ProfileView(userID: id)
                    }
                }
        }
        .environment(router)
    }
}
```

## パフォーマンス

### 大規模コレクションには遅延コンテナを使用

`LazyVStack` と `LazyHStack` は表示されたときのみビューを作成します：

```swift
ScrollView {
    LazyVStack(spacing: 8) {
        ForEach(items) { item in
            ItemRow(item: item)
        }
    }
}
```

### 安定した識別子

`ForEach` では常に安定した一意の ID を使用します。配列インデックスの使用は避けてください：

```swift
// Identifiable 準拠または明示的な id を使用
ForEach(items, id: \.stableID) { item in
    ItemRow(item: item)
}
```

### body 内での高コストな処理を避ける

- `body` 内で I/O、ネットワーク呼び出し、重い計算を絶対に行わない
- 非同期処理には `.task {}` を使用する -- ビューが消えると自動的にキャンセルされる
- スクロールビューでは `.sensoryFeedback()` と `.geometryGroup()` を控えめに使用する
- リスト内の `.shadow()`、`.blur()`、`.mask()` を最小限にする -- オフスクリーンレンダリングが発生する

### Equatable 準拠

高コストな body を持つビューの場合、`Equatable` に準拠して不要な再レンダリングをスキップします：

```swift
struct ExpensiveChartView: View, Equatable {
    let dataPoints: [DataPoint] // DataPoint は Equatable に準拠している必要がある

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.dataPoints == rhs.dataPoints
    }

    var body: some View {
        // 複雑なチャートレンダリング
    }
}
```

## プレビュー

高速なイテレーションのために、インラインのモックデータを使った `#Preview` マクロを使用します：

```swift
#Preview("Empty state") {
    ItemListView(viewModel: ItemListViewModel(repository: EmptyMockRepository()))
}

#Preview("Loaded") {
    ItemListView(viewModel: ItemListViewModel(repository: PopulatedMockRepository()))
}
```

## 避けるべきアンチパターン

- 新しいコードで `ObservableObject` / `@Published` / `@StateObject` / `@EnvironmentObject` を使用する -- `@Observable` に移行すること
- `body` や `init` 内に直接非同期処理を置く -- `.task {}` または明示的な load メソッドを使用する
- データを所有しない子ビュー内に `@State` として ViewModel を作成する -- 代わりに親から渡す
- `AnyView` による型消去を使用する -- 条件付きビューには `@ViewBuilder` または `Group` を使用する
- Actor との間でデータをやり取りする際に `Sendable` 要件を無視する

## 参照

スキル `swift-actor-persistence` を参照：Actor ベースの永続化パターン。
スキル `swift-protocol-di-testing` を参照：プロトコルベースの DI と Swift Testing によるテスト。
