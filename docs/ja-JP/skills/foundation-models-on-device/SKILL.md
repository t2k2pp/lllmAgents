---
name: foundation-models-on-device
description: Apple FoundationModels framework for on-device LLM — text generation, guided generation with @Generable, tool calling, and snapshot streaming in iOS 26+.
---

# FoundationModels: オンデバイスLLM (iOS 26)

FoundationModelsフレームワークを使用して、Appleのオンデバイス言語モデルをアプリに統合するためのパターン。テキスト生成、`@Generable`による構造化出力、カスタムツール呼び出し、スナップショットストリーミングをカバーする。すべてオンデバイスで実行され、プライバシーとオフラインサポートを実現。

## 発動条件

- Apple Intelligenceを使用したオンデバイスAI機能の構築
- クラウド依存なしでのテキスト生成または要約
- 自然言語入力からの構造化データの抽出
- ドメイン固有のAIアクション用カスタムツール呼び出しの実装
- リアルタイムUI更新のための構造化レスポンスのストリーミング
- プライバシー保護AI（データがデバイスから離れない）が必要な場合

## コアパターン -- 利用可能性チェック

セッションを作成する前に、必ずモデルの利用可能性を確認する:

```swift
struct GenerativeView: View {
    private var model = SystemLanguageModel.default

    var body: some View {
        switch model.availability {
        case .available:
            ContentView()
        case .unavailable(.deviceNotEligible):
            Text("Device not eligible for Apple Intelligence")
        case .unavailable(.appleIntelligenceNotEnabled):
            Text("Please enable Apple Intelligence in Settings")
        case .unavailable(.modelNotReady):
            Text("Model is downloading or not ready")
        case .unavailable(let other):
            Text("Model unavailable: \(other)")
        }
    }
}
```

## コアパターン -- 基本セッション

```swift
// シングルターン: 毎回新しいセッションを作成
let session = LanguageModelSession()
let response = try await session.respond(to: "What's a good month to visit Paris?")
print(response.content)

// マルチターン: 会話コンテキストのためにセッションを再利用
let session = LanguageModelSession(instructions: """
    You are a cooking assistant.
    Provide recipe suggestions based on ingredients.
    Keep suggestions brief and practical.
    """)

let first = try await session.respond(to: "I have chicken and rice")
let followUp = try await session.respond(to: "What about a vegetarian option?")
```

instructionsのポイント:
- モデルの役割を定義する（「あなたはメンターです」）
- 何をすべきかを指定する（「カレンダーイベントの抽出を手伝ってください」）
- スタイルの好みを設定する（「できるだけ簡潔に回答してください」）
- 安全対策を追加する（「危険なリクエストには『お手伝いできません』と回答してください」）

## コアパターン -- @Generableによるガイド付き生成

生の文字列の代わりに構造化されたSwift型を生成する:

### 1. Generable型の定義

```swift
@Generable(description: "Basic profile information about a cat")
struct CatProfile {
    var name: String

    @Guide(description: "The age of the cat", .range(0...20))
    var age: Int

    @Guide(description: "A one sentence profile about the cat's personality")
    var profile: String
}
```

### 2. 構造化出力のリクエスト

```swift
let response = try await session.respond(
    to: "Generate a cute rescue cat",
    generating: CatProfile.self
)

// 構造化フィールドに直接アクセス
print("Name: \(response.content.name)")
print("Age: \(response.content.age)")
print("Profile: \(response.content.profile)")
```

### サポートされる@Guide制約

- `.range(0...20)` -- 数値範囲
- `.count(3)` -- 配列要素数
- `description:` -- 生成のためのセマンティックガイダンス

## コアパターン -- ツール呼び出し

ドメイン固有のタスクのためにモデルがカスタムコードを呼び出せるようにする:

### 1. ツールの定義

```swift
struct RecipeSearchTool: Tool {
    let name = "recipe_search"
    let description = "Search for recipes matching a given term and return a list of results."

    @Generable
    struct Arguments {
        var searchTerm: String
        var numberOfResults: Int
    }

    func call(arguments: Arguments) async throws -> ToolOutput {
        let recipes = await searchRecipes(
            term: arguments.searchTerm,
            limit: arguments.numberOfResults
        )
        return .string(recipes.map { "- \($0.name): \($0.description)" }.joined(separator: "\n"))
    }
}
```

### 2. ツール付きセッションの作成

```swift
let session = LanguageModelSession(tools: [RecipeSearchTool()])
let response = try await session.respond(to: "Find me some pasta recipes")
```

### 3. ツールエラーの処理

```swift
do {
    let answer = try await session.respond(to: "Find a recipe for tomato soup.")
} catch let error as LanguageModelSession.ToolCallError {
    print(error.tool.name)
    if case .databaseIsEmpty = error.underlyingError as? RecipeSearchToolError {
        // 特定のツールエラーを処理
    }
}
```

## コアパターン -- スナップショットストリーミング

`PartiallyGenerated`型を使用してリアルタイムUIのための構造化レスポンスをストリーミングする:

```swift
@Generable
struct TripIdeas {
    @Guide(description: "Ideas for upcoming trips")
    var ideas: [String]
}

let stream = session.streamResponse(
    to: "What are some exciting trip ideas?",
    generating: TripIdeas.self
)

for try await partial in stream {
    // partial: TripIdeas.PartiallyGenerated（すべてのプロパティがOptional）
    print(partial)
}
```

### SwiftUI統合

```swift
@State private var partialResult: TripIdeas.PartiallyGenerated?
@State private var errorMessage: String?

var body: some View {
    List {
        ForEach(partialResult?.ideas ?? [], id: \.self) { idea in
            Text(idea)
        }
    }
    .overlay {
        if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
    }
    .task {
        do {
            let stream = session.streamResponse(to: prompt, generating: TripIdeas.self)
            for try await partial in stream {
                partialResult = partial
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
```

## 主要な設計判断

| 判断 | 根拠 |
|------|------|
| オンデバイス実行 | プライバシー -- データがデバイスから離れない。オフラインで動作 |
| 4,096トークン制限 | オンデバイスモデルの制約。大きなデータはセッション間でチャンクする |
| スナップショットストリーミング（デルタではなく） | 構造化出力に適している。各スナップショットは完全な部分状態 |
| `@Generable`マクロ | 構造化生成のコンパイル時安全性。`PartiallyGenerated`型を自動生成 |
| セッションごとに単一リクエスト | `isResponding`が並行リクエストを防ぐ。必要に応じて複数セッションを作成 |
| `response.content`（`.output`ではない） | 正しいAPI -- 結果には常に`.content`プロパティでアクセス |

## ベストプラクティス

- **セッション作成前に必ず`model.availability`を確認する** -- すべての利用不可ケースを処理する
- **`instructions`を使用してモデルの動作をガイドする** -- プロンプトより優先される
- **新しいリクエスト送信前に`isResponding`を確認する** -- セッションは一度に1つのリクエストを処理
- **結果には`response.content`でアクセスする** -- `.output`ではない
- **大きな入力はチャンクに分割する** -- 4,096トークン制限はinstructions + プロンプト + 出力の合計に適用
- **構造化出力には`@Generable`を使用する** -- 生の文字列のパースより強い保証
- **`GenerationOptions(temperature:)`で創造性を調整する** -- 高い = より創造的
- **Instrumentsでモニタリングする** -- Xcode Instrumentsを使用してリクエストパフォーマンスをプロファイル

## 避けるべきアンチパターン

- `model.availability`を確認せずにセッションを作成する
- 4,096トークンのコンテキストウィンドウを超える入力を送信する
- 単一セッションで並行リクエストを試みる
- レスポンスデータへのアクセスに`.content`ではなく`.output`を使用する
- `@Generable`構造化出力が使える場面で生の文字列レスポンスをパースする
- 単一のプロンプトに複雑なマルチステップロジックを構築する -- 複数の集中したプロンプトに分割する
- モデルが常に利用可能であると仮定する -- デバイスの適格性と設定は異なる

## 使用すべき場面

- プライバシーに敏感なアプリのためのオンデバイステキスト生成
- ユーザー入力からの構造化データ抽出（フォーム、自然言語コマンド）
- オフラインで動作する必要があるAI支援機能
- 生成されたコンテンツを段階的に表示するストリーミングUI
- ツール呼び出しによるドメイン固有のAIアクション（検索、計算、ルックアップ）
