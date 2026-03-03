# Rust API サービス — プロジェクト CLAUDE.md

> Axum、PostgreSQL、Docker を使用した Rust API サービスの実際のプロジェクト例。
> プロジェクトルートにコピーし、サービスに合わせてカスタマイズしてください。

## プロジェクト概要

**技術スタック:** Rust 1.78+、Axum（Web フレームワーク）、SQLx（非同期データベース）、PostgreSQL、Tokio（非同期ランタイム）、Docker

**アーキテクチャ:** ハンドラー → サービス → リポジトリの分離によるレイヤードアーキテクチャ。HTTP に Axum、コンパイル時型チェック SQL に SQLx、横断的関心事に Tower ミドルウェアを使用。

## 必須ルール

### Rust 規約

- ライブラリエラーには `thiserror` を使用、`anyhow` はバイナリクレートまたはテストでのみ使用
- 本番コードで `.unwrap()` や `.expect()` は禁止 — `?` でエラーを伝播
- 関数パラメータには `String` より `&str` を優先。所有権が移転する場合は `String` を返す
- `clippy` を `#![deny(clippy::all, clippy::pedantic)]` で使用 — すべての警告を修正
- すべての公開型に `Debug` を derive。`Clone`、`PartialEq` は必要な場合のみ derive
- `// SAFETY:` コメントで正当化されない限り `unsafe` ブロックは禁止

### データベース

- すべてのクエリは SQLx `query!` または `query_as!` マクロを使用 — スキーマに対してコンパイル時検証
- マイグレーションは `migrations/` に `sqlx migrate` を使用 — データベースを直接変更しない
- 共有状態として `sqlx::Pool<Postgres>` を使用 — リクエストごとにコネクションを作成しない
- すべてのクエリはパラメータ化されたプレースホルダー（`$1`、`$2`）を使用 — 文字列フォーマットは禁止

```rust
// 悪い例: 文字列補間（SQL インジェクションのリスク）
let q = format!("SELECT * FROM users WHERE id = '{}'", id);

// 良い例: パラメータ化クエリ、コンパイル時チェック
let user = sqlx::query_as!(User, "SELECT * FROM users WHERE id = $1", id)
    .fetch_optional(&pool)
    .await?;
```

### エラーハンドリング

- `thiserror` を使用してモジュールごとにドメインエラー列挙型を定義
- `IntoResponse` 経由でエラーを HTTP レスポンスにマッピング — 内部詳細を公開しない
- 構造化ロギングに `tracing` を使用 — `println!` や `eprintln!` は禁止

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Resource not found")]
    NotFound,
    #[error("Validation failed: {0}")]
    Validation(String),
    #[error("Unauthorized")]
    Unauthorized,
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            Self::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            Self::Validation(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            Self::Internal(err) => {
                tracing::error!(?err, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal error".into())
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}
```

### テスト

- 各ソースファイル内の `#[cfg(test)]` モジュールでユニットテスト
- `tests/` ディレクトリで実際の PostgreSQL（Testcontainers または Docker）を使用した統合テスト
- 自動マイグレーションとロールバック付きのデータベーステストに `#[sqlx::test]` を使用
- 外部サービスのモックに `mockall` または `wiremock` を使用

### コードスタイル

- 最大行長: 100文字（rustfmt で強制）
- インポートのグループ化: `std`、外部クレート、`crate`/`super` — 空行で区切り
- モジュール: モジュールごとに1ファイル、`mod.rs` は再エクスポートのみ
- 型: PascalCase、関数/変数: snake_case、定数: UPPER_SNAKE_CASE

## ファイル構造

```
src/
  main.rs              # エントリーポイント、サーバーセットアップ、グレースフルシャットダウン
  lib.rs               # 統合テスト用の再エクスポート
  config.rs            # envy または figment による環境設定
  router.rs            # すべてのルートを持つ Axum ルーター
  middleware/
    auth.rs            # JWT の抽出と検証
    logging.rs         # リクエスト/レスポンスのトレーシング
  handlers/
    mod.rs             # ルートハンドラー（薄い — サービスに委譲）
    users.rs
    orders.rs
  services/
    mod.rs             # ビジネスロジック
    users.rs
    orders.rs
  repositories/
    mod.rs             # データベースアクセス（SQLx クエリ）
    users.rs
    orders.rs
  domain/
    mod.rs             # ドメイン型、エラー列挙型
    user.rs
    order.rs
migrations/
  001_create_users.sql
  002_create_orders.sql
tests/
  common/mod.rs        # 共有テストヘルパー、テストサーバーセットアップ
  api_users.rs         # ユーザーエンドポイントの統合テスト
  api_orders.rs        # 注文エンドポイントの統合テスト
```

## 主要パターン

### ハンドラー（薄い）

```rust
async fn create_user(
    State(ctx): State<AppState>,
    Json(payload): Json<CreateUserRequest>,
) -> Result<(StatusCode, Json<UserResponse>), AppError> {
    let user = ctx.user_service.create(payload).await?;
    Ok((StatusCode::CREATED, Json(UserResponse::from(user))))
}
```

### サービス（ビジネスロジック）

```rust
impl UserService {
    pub async fn create(&self, req: CreateUserRequest) -> Result<User, AppError> {
        if self.repo.find_by_email(&req.email).await?.is_some() {
            return Err(AppError::Validation("Email already registered".into()));
        }

        let password_hash = hash_password(&req.password)?;
        let user = self.repo.insert(&req.email, &req.name, &password_hash).await?;

        Ok(user)
    }
}
```

### リポジトリ（データアクセス）

```rust
impl UserRepository {
    pub async fn find_by_email(&self, email: &str) -> Result<Option<User>, sqlx::Error> {
        sqlx::query_as!(User, "SELECT * FROM users WHERE email = $1", email)
            .fetch_optional(&self.pool)
            .await
    }

    pub async fn insert(
        &self,
        email: &str,
        name: &str,
        password_hash: &str,
    ) -> Result<User, sqlx::Error> {
        sqlx::query_as!(
            User,
            r#"INSERT INTO users (email, name, password_hash)
               VALUES ($1, $2, $3) RETURNING *"#,
            email, name, password_hash,
        )
        .fetch_one(&self.pool)
        .await
    }
}
```

### 統合テスト

```rust
#[tokio::test]
async fn test_create_user() {
    let app = spawn_test_app().await;

    let response = app
        .client
        .post(&format!("{}/api/v1/users", app.address))
        .json(&json!({
            "email": "alice@example.com",
            "name": "Alice",
            "password": "securepassword123"
        }))
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(response.status(), StatusCode::CREATED);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["email"], "alice@example.com");
}

#[tokio::test]
async fn test_create_user_duplicate_email() {
    let app = spawn_test_app().await;
    // 最初のユーザーを作成
    create_test_user(&app, "alice@example.com").await;
    // 重複を試行
    let response = create_user_request(&app, "alice@example.com").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
```

## 環境変数

```bash
# サーバー
HOST=0.0.0.0
PORT=8080
RUST_LOG=info,tower_http=debug

# データベース
DATABASE_URL=postgres://user:pass@localhost:5432/myapp

# 認証
JWT_SECRET=your-secret-key-min-32-chars
JWT_EXPIRY_HOURS=24

# オプション
CORS_ALLOWED_ORIGINS=http://localhost:3000
```

## テスト戦略

```bash
# すべてのテストを実行
cargo test

# 出力付きで実行
cargo test -- --nocapture

# 特定のテストモジュールを実行
cargo test api_users

# カバレッジ確認（cargo-llvm-cov が必要）
cargo llvm-cov --html
open target/llvm-cov/html/index.html

# リント
cargo clippy -- -D warnings

# フォーマットチェック
cargo fmt -- --check
```

## ECC ワークフロー

```bash
# 計画
/plan "Add order fulfillment with Stripe payment"

# TDD で開発
/tdd                    # cargo test ベースの TDD ワークフロー

# レビュー
/code-review            # Rust 固有のコードレビュー
/security-scan          # 依存関係監査 + unsafe スキャン

# 検証
/verify                 # ビルド、clippy、テスト、セキュリティスキャン
```

## Git ワークフロー

- `feat:` 新機能、`fix:` バグ修正、`refactor:` コード変更
- `main` からフィーチャーブランチ、PR 必須
- CI: `cargo fmt --check`、`cargo clippy`、`cargo test`、`cargo audit`
- デプロイ: `scratch` または `distroless` ベースの Docker マルチステージビルド
