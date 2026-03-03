---
name: api-design
description: REST API design patterns including resource naming, status codes, pagination, filtering, error responses, versioning, and rate limiting for production APIs.
origin: ECC
---

# API設計パターン

一貫性があり、開発者にとって使いやすいREST APIを設計するための規約とベストプラクティス。

## 発動条件

- 新しいAPIエンドポイントを設計する時
- 既存のAPIコントラクトをレビューする時
- ページネーション、フィルタリング、またはソートを追加する時
- APIのエラーハンドリングを実装する時
- APIバージョニング戦略を計画する時
- 公開APIまたはパートナー向けAPIを構築する時

## リソース設計

### URL構造

```
# リソースは名詞、複数形、小文字、ケバブケースで記述
GET    /api/v1/users
GET    /api/v1/users/:id
POST   /api/v1/users
PUT    /api/v1/users/:id
PATCH  /api/v1/users/:id
DELETE /api/v1/users/:id

# 関連性を表すサブリソース
GET    /api/v1/users/:id/orders
POST   /api/v1/users/:id/orders

# CRUDにマッピングできないアクション（動詞は控えめに使用）
POST   /api/v1/orders/:id/cancel
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
```

### 命名規則

```
# 良い例
/api/v1/team-members          # 複合語にはケバブケースを使用
/api/v1/orders?status=active  # フィルタリングにはクエリパラメータを使用
/api/v1/users/123/orders      # 所有関係にはネストされたリソースを使用

# 悪い例
/api/v1/getUsers              # URLに動詞を含めている
/api/v1/user                  # 単数形（複数形を使用すべき）
/api/v1/team_members          # URLにスネークケースを使用
/api/v1/users/123/getOrders   # ネストされたリソースに動詞を含めている
```

## HTTPメソッドとステータスコード

### メソッドのセマンティクス

| メソッド | 冪等性 | 安全性 | 用途 |
|--------|-------|------|------|
| GET | あり | あり | リソースの取得 |
| POST | なし | なし | リソースの作成、アクションのトリガー |
| PUT | あり | なし | リソースの完全な置換 |
| PATCH | なし* | なし | リソースの部分的な更新 |
| DELETE | あり | なし | リソースの削除 |

*PATCHは適切な実装により冪等にすることが可能

### ステータスコードリファレンス

```
# 成功
200 OK                    — GET, PUT, PATCH（レスポンスボディあり）
201 Created               — POST（Locationヘッダーを含める）
204 No Content            — DELETE, PUT（レスポンスボディなし）

# クライアントエラー
400 Bad Request           — バリデーション失敗、不正なJSON
401 Unauthorized          — 認証が未提供または無効
403 Forbidden             — 認証済みだが権限なし
404 Not Found             — リソースが存在しない
409 Conflict              — 重複エントリ、状態の競合
422 Unprocessable Entity  — 意味的に無効（JSONは有効だがデータが不正）
429 Too Many Requests     — レート制限超過

# サーバーエラー
500 Internal Server Error — 予期しない障害（詳細は絶対に公開しない）
502 Bad Gateway           — 上流サービスの障害
503 Service Unavailable   — 一時的な過負荷、Retry-Afterを含める
```

### よくある間違い

```
# 悪い例: すべてに200を返す
{ "status": 200, "success": false, "error": "Not found" }

# 良い例: HTTPステータスコードをセマンティクスに従って使用
HTTP/1.1 404 Not Found
{ "error": { "code": "not_found", "message": "User not found" } }

# 悪い例: バリデーションエラーに500を使用
# 良い例: フィールドレベルの詳細付きで400または422を使用

# 悪い例: 作成されたリソースに200を使用
# 良い例: Locationヘッダー付きで201を使用
HTTP/1.1 201 Created
Location: /api/v1/users/abc-123
```

## レスポンス形式

### 成功レスポンス

```json
{
  "data": {
    "id": "abc-123",
    "email": "alice@example.com",
    "name": "Alice",
    "created_at": "2025-01-15T10:30:00Z"
  }
}
```

### コレクションレスポンス（ページネーション付き）

```json
{
  "data": [
    { "id": "abc-123", "name": "Alice" },
    { "id": "def-456", "name": "Bob" }
  ],
  "meta": {
    "total": 142,
    "page": 1,
    "per_page": 20,
    "total_pages": 8
  },
  "links": {
    "self": "/api/v1/users?page=1&per_page=20",
    "next": "/api/v1/users?page=2&per_page=20",
    "last": "/api/v1/users?page=8&per_page=20"
  }
}
```

### エラーレスポンス

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "details": [
      {
        "field": "email",
        "message": "Must be a valid email address",
        "code": "invalid_format"
      },
      {
        "field": "age",
        "message": "Must be between 0 and 150",
        "code": "out_of_range"
      }
    ]
  }
}
```

### レスポンスエンベロープのバリエーション

```typescript
// オプションA: dataラッパー付きエンベロープ（公開APIに推奨）
interface ApiResponse<T> {
  data: T;
  meta?: PaginationMeta;
  links?: PaginationLinks;
}

interface ApiError {
  error: {
    code: string;
    message: string;
    details?: FieldError[];
  };
}

// オプションB: フラットレスポンス（よりシンプル、内部APIで一般的）
// 成功: リソースを直接返す
// エラー: エラーオブジェクトを返す
// HTTPステータスコードで区別する
```

## ページネーション

### オフセットベース（シンプル）

```
GET /api/v1/users?page=2&per_page=20

# 実装
SELECT * FROM users
ORDER BY created_at DESC
LIMIT 20 OFFSET 20;
```

**メリット:** 実装が容易、「N番目のページにジャンプ」が可能
**デメリット:** 大きなオフセットで低速（OFFSET 100000）、同時挿入時に不整合が発生

### カーソルベース（スケーラブル）

```
GET /api/v1/users?cursor=eyJpZCI6MTIzfQ&limit=20

# 実装
SELECT * FROM users
WHERE id > :cursor_id
ORDER BY id ASC
LIMIT 21;  -- has_nextを判定するため1件多く取得
```

```json
{
  "data": [...],
  "meta": {
    "has_next": true,
    "next_cursor": "eyJpZCI6MTQzfQ"
  }
}
```

**メリット:** 位置に関係なく一貫したパフォーマンス、同時挿入時も安定
**デメリット:** 任意のページへのジャンプ不可、カーソルは不透明

### 使い分けの基準

| ユースケース | ページネーション方式 |
|------------|-------------------|
| 管理画面、小規模データセット（1万件未満） | オフセット |
| 無限スクロール、フィード、大規模データセット | カーソル |
| 公開API | カーソル（デフォルト）＋オフセット（オプション） |
| 検索結果 | オフセット（ユーザーはページ番号を期待する） |

## フィルタリング、ソート、検索

### フィルタリング

```
# 単純な等値比較
GET /api/v1/orders?status=active&customer_id=abc-123

# 比較演算子（ブラケット記法を使用）
GET /api/v1/products?price[gte]=10&price[lte]=100
GET /api/v1/orders?created_at[after]=2025-01-01

# 複数値（カンマ区切り）
GET /api/v1/products?category=electronics,clothing

# ネストされたフィールド（ドット記法）
GET /api/v1/orders?customer.country=US
```

### ソート

```
# 単一フィールド（降順にはプレフィックス - を使用）
GET /api/v1/products?sort=-created_at

# 複数フィールド（カンマ区切り）
GET /api/v1/products?sort=-featured,price,-created_at
```

### 全文検索

```
# 検索クエリパラメータ
GET /api/v1/products?q=wireless+headphones

# フィールド指定検索
GET /api/v1/users?email=alice
```

### スパースフィールドセット

```
# 指定したフィールドのみを返す（ペイロードの削減）
GET /api/v1/users?fields=id,name,email
GET /api/v1/orders?fields=id,total,status&include=customer.name
```

## 認証と認可

### トークンベース認証

```
# AuthorizationヘッダーにBearerトークンを指定
GET /api/v1/users
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

# APIキー（サーバー間通信用）
GET /api/v1/data
X-API-Key: sk_live_abc123
```

### 認可パターン

```typescript
// リソースレベル: 所有権の確認
app.get("/api/v1/orders/:id", async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: { code: "not_found" } });
  if (order.userId !== req.user.id) return res.status(403).json({ error: { code: "forbidden" } });
  return res.json({ data: order });
});

// ロールベース: 権限の確認
app.delete("/api/v1/users/:id", requireRole("admin"), async (req, res) => {
  await User.delete(req.params.id);
  return res.status(204).send();
});
```

## レート制限

### ヘッダー

```
HTTP/1.1 200 OK
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640000000

# 超過時
HTTP/1.1 429 Too Many Requests
Retry-After: 60
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Rate limit exceeded. Try again in 60 seconds."
  }
}
```

### レート制限ティア

| ティア | 制限 | ウィンドウ | ユースケース |
|-------|------|----------|------------|
| 匿名 | 30/分 | IPごと | 公開エンドポイント |
| 認証済み | 100/分 | ユーザーごと | 標準APIアクセス |
| プレミアム | 1000/分 | APIキーごと | 有料APIプラン |
| 内部 | 10000/分 | サービスごと | サービス間通信 |

## バージョニング

### URLパスバージョニング（推奨）

```
/api/v1/users
/api/v2/users
```

**メリット:** 明示的、ルーティングが容易、キャッシュ可能
**デメリット:** バージョン間でURLが変わる

### ヘッダーバージョニング

```
GET /api/users
Accept: application/vnd.myapp.v2+json
```

**メリット:** URLがクリーン
**デメリット:** テストが困難、忘れやすい

### バージョニング戦略

```
1. /api/v1/ から開始 — 必要になるまでバージョニングしない
2. アクティブなバージョンは最大2つ（現行 + 前バージョン）
3. 廃止タイムライン:
   - 廃止を告知（公開APIは6ヶ月前に通知）
   - Sunsetヘッダーを追加: Sunset: Sat, 01 Jan 2026 00:00:00 GMT
   - 廃止日以降は410 Goneを返す
4. 破壊的でない変更には新バージョン不要:
   - レスポンスへの新フィールド追加
   - 新しいオプションクエリパラメータの追加
   - 新しいエンドポイントの追加
5. 破壊的な変更には新バージョンが必要:
   - フィールドの削除または名前変更
   - フィールド型の変更
   - URL構造の変更
   - 認証方式の変更
```

## 実装パターン

### TypeScript (Next.js API Route)

```typescript
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = createUserSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({
      error: {
        code: "validation_error",
        message: "Request validation failed",
        details: parsed.error.issues.map(i => ({
          field: i.path.join("."),
          message: i.message,
          code: i.code,
        })),
      },
    }, { status: 422 });
  }

  const user = await createUser(parsed.data);

  return NextResponse.json(
    { data: user },
    {
      status: 201,
      headers: { Location: `/api/v1/users/${user.id}` },
    },
  );
}
```

### Python (Django REST Framework)

```python
from rest_framework import serializers, viewsets, status
from rest_framework.response import Response

class CreateUserSerializer(serializers.Serializer):
    email = serializers.EmailField()
    name = serializers.CharField(max_length=100)

class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "email", "name", "created_at"]

class UserViewSet(viewsets.ModelViewSet):
    serializer_class = UserSerializer
    permission_classes = [IsAuthenticated]

    def get_serializer_class(self):
        if self.action == "create":
            return CreateUserSerializer
        return UserSerializer

    def create(self, request):
        serializer = CreateUserSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = UserService.create(**serializer.validated_data)
        return Response(
            {"data": UserSerializer(user).data},
            status=status.HTTP_201_CREATED,
            headers={"Location": f"/api/v1/users/{user.id}"},
        )
```

### Go (net/http)

```go
func (h *UserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
    var req CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        writeError(w, http.StatusBadRequest, "invalid_json", "Invalid request body")
        return
    }

    if err := req.Validate(); err != nil {
        writeError(w, http.StatusUnprocessableEntity, "validation_error", err.Error())
        return
    }

    user, err := h.service.Create(r.Context(), req)
    if err != nil {
        switch {
        case errors.Is(err, domain.ErrEmailTaken):
            writeError(w, http.StatusConflict, "email_taken", "Email already registered")
        default:
            writeError(w, http.StatusInternalServerError, "internal_error", "Internal error")
        }
        return
    }

    w.Header().Set("Location", fmt.Sprintf("/api/v1/users/%s", user.ID))
    writeJSON(w, http.StatusCreated, map[string]any{"data": user})
}
```

## API設計チェックリスト

新しいエンドポイントをリリースする前に:

- [ ] リソースURLが命名規約に従っている（複数形、ケバブケース、動詞なし）
- [ ] 正しいHTTPメソッドが使用されている（読み取りにはGET、作成にはPOSTなど）
- [ ] 適切なステータスコードが返されている（すべてに200を使用していない）
- [ ] スキーマによる入力バリデーション（Zod、Pydantic、Bean Validation）
- [ ] エラーレスポンスがコードとメッセージを含む標準形式に従っている
- [ ] 一覧エンドポイントにページネーションが実装されている（カーソルまたはオフセット）
- [ ] 認証が必要（または明示的に公開と指定されている）
- [ ] 認可チェック（ユーザーは自身のリソースのみアクセス可能）
- [ ] レート制限が設定されている
- [ ] レスポンスが内部の詳細を漏洩していない（スタックトレース、SQLエラー）
- [ ] 既存エンドポイントとの命名の一貫性（camelCase vs snake_case）
- [ ] ドキュメント化されている（OpenAPI/Swagger仕様が更新済み）
