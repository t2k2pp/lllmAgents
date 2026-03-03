---
name: liquid-glass-design
description: iOS 26 Liquid Glass design system — dynamic glass material with blur, reflection, and interactive morphing for SwiftUI, UIKit, and WidgetKit.
---

# Liquid Glass デザインシステム (iOS 26)

Apple の Liquid Glass を実装するためのパターン集です。Liquid Glass は、背後のコンテンツをぼかし、周囲のコンテンツから色と光を反射し、タッチおよびポインター操作に反応する動的マテリアルです。SwiftUI、UIKit、WidgetKit の統合をカバーしています。

## 有効化するタイミング

- iOS 26+ 向けの新しいデザイン言語でアプリを構築または更新する場合
- ガラススタイルのボタン、カード、ツールバー、コンテナを実装する場合
- ガラス要素間のモーフィングトランジションを作成する場合
- ウィジェットに Liquid Glass エフェクトを適用する場合
- 既存のブラー/マテリアルエフェクトを新しい Liquid Glass API に移行する場合

## コアパターン -- SwiftUI

### 基本的なガラスエフェクト

任意のビューに Liquid Glass を追加する最もシンプルな方法：

```swift
Text("Hello, World!")
    .font(.title)
    .padding()
    .glassEffect()  // Default: regular variant, capsule shape
```

### シェイプとティントのカスタマイズ

```swift
Text("Hello, World!")
    .font(.title)
    .padding()
    .glassEffect(.regular.tint(.orange).interactive(), in: .rect(cornerRadius: 16.0))
```

主要なカスタマイズオプション：
- `.regular` -- 標準のガラスエフェクト
- `.tint(Color)` -- 強調のためにカラーティントを追加
- `.interactive()` -- タッチおよびポインター操作に反応
- シェイプ：`.capsule`（デフォルト）、`.rect(cornerRadius:)`、`.circle`

### ガラスボタンスタイル

```swift
Button("Click Me") { /* action */ }
    .buttonStyle(.glass)

Button("Important") { /* action */ }
    .buttonStyle(.glassProminent)
```

### 複数要素のための GlassEffectContainer

パフォーマンスとモーフィングのために、複数のガラスビューは必ずコンテナで囲みます：

```swift
GlassEffectContainer(spacing: 40.0) {
    HStack(spacing: 40.0) {
        Image(systemName: "scribble.variable")
            .frame(width: 80.0, height: 80.0)
            .font(.system(size: 36))
            .glassEffect()

        Image(systemName: "eraser.fill")
            .frame(width: 80.0, height: 80.0)
            .font(.system(size: 36))
            .glassEffect()
    }
}
```

`spacing` パラメータはマージ距離を制御します。近い要素ほどガラスシェイプが融合します。

### ガラスエフェクトの結合

`glassEffectUnion` を使って複数のビューを一つのガラスシェイプに結合します：

```swift
@Namespace private var namespace

GlassEffectContainer(spacing: 20.0) {
    HStack(spacing: 20.0) {
        ForEach(symbolSet.indices, id: \.self) { item in
            Image(systemName: symbolSet[item])
                .frame(width: 80.0, height: 80.0)
                .glassEffect()
                .glassEffectUnion(id: item < 2 ? "group1" : "group2", namespace: namespace)
        }
    }
}
```

### モーフィングトランジション

ガラス要素の表示/非表示時にスムーズなモーフィングを作成します：

```swift
@State private var isExpanded = false
@Namespace private var namespace

GlassEffectContainer(spacing: 40.0) {
    HStack(spacing: 40.0) {
        Image(systemName: "scribble.variable")
            .frame(width: 80.0, height: 80.0)
            .glassEffect()
            .glassEffectID("pencil", in: namespace)

        if isExpanded {
            Image(systemName: "eraser.fill")
                .frame(width: 80.0, height: 80.0)
                .glassEffect()
                .glassEffectID("eraser", in: namespace)
        }
    }
}

Button("Toggle") {
    withAnimation { isExpanded.toggle() }
}
.buttonStyle(.glass)
```

### サイドバー下への水平スクロールの拡張

水平スクロールコンテンツをサイドバーやインスペクタの下に拡張するには、`ScrollView` のコンテンツがコンテナの先端/末端エッジまで達するようにします。レイアウトがエッジまで拡張されている場合、システムが自動的にサイドバー下のスクロール動作を処理します。追加のモディファイアは不要です。

## コアパターン -- UIKit

### 基本的な UIGlassEffect

```swift
let glassEffect = UIGlassEffect()
glassEffect.tintColor = UIColor.systemBlue.withAlphaComponent(0.3)
glassEffect.isInteractive = true

let visualEffectView = UIVisualEffectView(effect: glassEffect)
visualEffectView.translatesAutoresizingMaskIntoConstraints = false
visualEffectView.layer.cornerRadius = 20
visualEffectView.clipsToBounds = true

view.addSubview(visualEffectView)
NSLayoutConstraint.activate([
    visualEffectView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
    visualEffectView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    visualEffectView.widthAnchor.constraint(equalToConstant: 200),
    visualEffectView.heightAnchor.constraint(equalToConstant: 120)
])

// contentView にコンテンツを追加
let label = UILabel()
label.text = "Liquid Glass"
label.translatesAutoresizingMaskIntoConstraints = false
visualEffectView.contentView.addSubview(label)
NSLayoutConstraint.activate([
    label.centerXAnchor.constraint(equalTo: visualEffectView.contentView.centerXAnchor),
    label.centerYAnchor.constraint(equalTo: visualEffectView.contentView.centerYAnchor)
])
```

### 複数要素のための UIGlassContainerEffect

```swift
let containerEffect = UIGlassContainerEffect()
containerEffect.spacing = 40.0

let containerView = UIVisualEffectView(effect: containerEffect)

let firstGlass = UIVisualEffectView(effect: UIGlassEffect())
let secondGlass = UIVisualEffectView(effect: UIGlassEffect())

containerView.contentView.addSubview(firstGlass)
containerView.contentView.addSubview(secondGlass)
```

### スクロールエッジエフェクト

```swift
scrollView.topEdgeEffect.style = .automatic
scrollView.bottomEdgeEffect.style = .hard
scrollView.leftEdgeEffect.isHidden = true
```

### ツールバーのガラス統合

```swift
let favoriteButton = UIBarButtonItem(image: UIImage(systemName: "heart"), style: .plain, target: self, action: #selector(favoriteAction))
favoriteButton.hidesSharedBackground = true  // 共有ガラス背景からオプトアウト
```

## コアパターン -- WidgetKit

### レンダリングモード検出

```swift
struct MyWidgetView: View {
    @Environment(\.widgetRenderingMode) var renderingMode

    var body: some View {
        if renderingMode == .accented {
            // ティントモード：白色ティント付きテーマガラス背景
        } else {
            // フルカラーモード：標準の外観
        }
    }
}
```

### 視覚的階層のためのアクセントグループ

```swift
HStack {
    VStack(alignment: .leading) {
        Text("Title")
            .widgetAccentable()  // アクセントグループ
        Text("Subtitle")
            // プライマリグループ（デフォルト）
    }
    Image(systemName: "star.fill")
        .widgetAccentable()  // アクセントグループ
}
```

### アクセントモードでの画像レンダリング

```swift
Image("myImage")
    .widgetAccentedRenderingMode(.monochrome)
```

### コンテナ背景

```swift
VStack { /* content */ }
    .containerBackground(for: .widget) {
        Color.blue.opacity(0.2)
    }
```

## 主要な設計判断

| 判断 | 根拠 |
|------|------|
| GlassEffectContainer によるラッピング | パフォーマンス最適化、ガラス要素間のモーフィングを有効化 |
| `spacing` パラメータ | マージ距離の制御 -- 要素が融合する近さを微調整 |
| `@Namespace` + `glassEffectID` | ビュー階層の変更時にスムーズなモーフィングトランジションを有効化 |
| `interactive()` モディファイア | タッチ/ポインター反応への明示的なオプトイン -- すべてのガラスが反応すべきではない |
| UIKit の UIGlassContainerEffect | SwiftUI と同じコンテナパターンで一貫性を確保 |
| ウィジェットのアクセントレンダリングモード | ユーザーがティント付きホーム画面を選択した際にシステムがティントガラスを適用 |

## ベストプラクティス

- 複数の兄弟ビューにガラスを適用する場合は**必ず GlassEffectContainer を使用**する -- モーフィングを有効化し、レンダリングパフォーマンスを向上させる
- **`.glassEffect()` は他の外観モディファイアの後に適用**する（frame、font、padding）
- **`.interactive()` はユーザー操作に応答する要素のみに使用**する（ボタン、トグル可能な項目）
- コンテナ内の **spacing を慎重に選択**し、ガラスエフェクトがいつマージされるかを制御する
- ビュー階層の変更時にスムーズなモーフィングトランジションを有効にするには **`withAnimation` を使用**する
- **外観をまたいでテスト**する -- ライトモード、ダークモード、アクセント/ティントモード
- **アクセシビリティのコントラストを確保**する -- ガラス上のテキストは可読性を保つ必要がある

## 避けるべきアンチパターン

- GlassEffectContainer なしで複数のスタンドアロン `.glassEffect()` ビューを使用する
- ガラスエフェクトのネストが深すぎる -- パフォーマンスと視覚的な明瞭さが低下する
- すべてのビューにガラスを適用する -- インタラクティブ要素、ツールバー、カードに限定する
- UIKit でコーナー半径使用時に `clipsToBounds = true` を忘れる
- ウィジェットでアクセントレンダリングモードを無視する -- ティント付きホーム画面の表示が壊れる
- ガラスの背後に不透明な背景を使用する -- 半透明効果が無効になる

## 使用するタイミング

- 新しい iOS 26 デザインによるナビゲーションバー、ツールバー、タブバー
- フローティングアクションボタンとカードスタイルのコンテナ
- 視覚的な深さとタッチフィードバックが必要なインタラクティブコントロール
- システムの Liquid Glass 外観と統合するウィジェット
- 関連する UI 状態間のモーフィングトランジション
