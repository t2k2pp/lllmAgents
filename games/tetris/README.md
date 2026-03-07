# Space Shooter - 縦スクロールシューティングゲーム

## 概要

HTML5 Canvas を使用したブラウザ向けの縦スクロールシューティングゲーム。

## 仕様

### 基本情報

| 項目 | 内容 |
|------|------|
| ジャンル | 縦スクロールシューティング |
| プラットフォーム | Web ブラウザ |
| 技術スタック | HTML5 + CSS3 + JavaScript (Canvas API) |
| ゲームサイズ | 480 x 640 ピクセル |

### ゲームシステム

#### プレイヤー

- **ライフ**: 3 ライフ
- **移動**: 4 方向（上下左右）自由移動
- **移動速度**: 5 ピクセル/フレーム
- **射撃**: 連射可能（クールダウン 150ms）
- **無敵時間**: 被弾後 2 秒

#### 敵機

| 種類 | 出現ウェーブ | 耐久 | 速度 | 得点 |
|------|-------------|------|------|------|
| Basic | 1 波から | 1 | 中 | 100 点 |
| Fast | 2 波から | 1 | 高速 | 200 点 |
| Tank | 3 波から | 3 | 低速 | 300 点 |

#### ウェーブシステム

- **ウェーブ上昇**: スコア每 2000 点でウェーブが上昇
- **敵出現間隔**: ウェーブ上昇に伴い短縮（最大 1500ms → 最小 500ms）
- **敵速度**: ウェーブ上昇に伴い増加

#### ボムシステム

- **発動キー**: X キー
- **効果**: 画面上の全敵を破壊
- **得点**: 破壊した敵の通常得点が加算

### 操作

| キー | 動作 |
|------|------|
| ← | 左移動 |
| → | 右移動 |
| ↑ | 上移動 |
| ↓ | 下移動 |
| Z | 射撃 |
| X | ボム発動 |
| P | 一時停止/再開 |

### スコアリング

#### 得点獲得方法

- 敵破壊：100-300 点（敵タイプによる）
- ハイスコア：ローカルストレージに永続保存

#### ウェーブ別敵配置

| ウェーブ | 出現敵タイプ |
|---------|-------------|
| 1 波 | Basic |
| 2 波 | Basic, Fast |
| 3 波以降 | Basic, Fast, Tank |

### ゲームフロー

```
開始画面
    ↓
Start Game ボタンクリック
    ↓
ゲーム開始（ウェーブ 1）
    ↓
敵出現 → 戦闘 → スコア獲得
    ↓
ウェーブ上昇（スコア条件達成時）
    ↓
ライフ残数確認
    ├─ ライフ > 0 → ゲーム継続
    └─ ライフ = 0 → Game Over
                    ↓
              スコア表示
                    ↓
              ハイスコア更新（更新時）
```

### 技術仕様

#### クラス構成

```
SpaceShooter
├── 初期化
│   ├── constructor()
│   ├── initStars()
│   └── loadHighScore()
├── ゲーム制御
│   ├── start()
│   ├── update(time)
│   └── draw()
├── プレイヤー
│   ├── updatePlayer()
│   ├── drawPlayer()
│   └── playerHit()
├── 弾
│   ├── fireBullet()
│   └── updateBullets(deltaTime)
├── 敵
│   ├── spawnEnemies(time)
│   ├── updateEnemies(deltaTime)
│   └── drawEnemy(enemy)
├── 衝突判定
│   ├── checkCollisions()
│   └── rectIntersect(x1, y1, w1, h1, x2, y2, w2, h2)
├── エフェクト
│   ├── createExplosion(x, y, color)
│   ├── updateExplosions(deltaTime)
│   └── updateStars()
├── ボム
│   └── fireBomb()
└── UI
    ├── updateUI()
    ├── addScore(points)
    ├── showGameOver()
    ├── saveHighScore()
    └── loadHighScore()
```

#### 描画レイヤー

1. 背景グラデーション
2. 星フィールド（スクロールアニメーション）
3. 爆発エフェクト
4. 弾
5. 敵機
6. プレイヤー機
7. Game Over / Pause オーバーレイ

#### 入力処理

- キーダウン/アップイベントリスナー
- キー状態保持（連動移動対応）
- 射撃クールダウン管理

#### 永続化

- **localStorage キー**: `spaceShooterHighScore`
- **保存タイミング**: Game Over 時

### 拡張性

#### 実装可能な機能

- [ ] ボーナスアイテム（パワーアップ）
- [ ] チef ボス戦
- [ ] 複数プレイヤーモード
- [ ] 音声効果
- [ ] レベルセレクト
- [ ] 高難度モード

#### パラメータ調整ポイント

| パラメータ | 現在値 | 調整範囲 |
|-----------|--------|---------|
| playerSpeed | 5 | 3-10 |
| bulletSpeed | 10 | 8-15 |
| fireCooldown | 150ms | 100-300ms |
| enemySpawnRate | 1500ms | 800-2000ms |
| 無敵時間 | 2000ms | 1000-3000ms |

## ファイル構成

```
games/tetris/
├── index.html    # ゲーム UI 構造
├── style.css     # スタイル定義
├── game.js       # ゲームロジック
└── README.md     # 本ドキュメント
```

## 起動方法

```bash
# ブラウザで開く
open games/tetris/index.html

# または HTTP サーバーで
npx serve games/tetris/
```

## 開発履歴

- **バージョン**: 1.0.0
- **作成日**: 2024 年
- **技術スタック**: HTML5 Canvas, Vanilla JavaScript
