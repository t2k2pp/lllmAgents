---
name: database-migrations
description: Database migration best practices for schema changes, data migrations, rollbacks, and zero-downtime deployments across PostgreSQL, MySQL, and common ORMs (Prisma, Drizzle, Django, TypeORM, golang-migrate).
origin: ECC
---

# データベースマイグレーションパターン

本番システムのための安全で可逆的なデータベーススキーマ変更。

## 発動条件

- データベーステーブルの作成または変更
- カラムやインデックスの追加/削除
- データマイグレーション（バックフィル、変換）の実行
- ゼロダウンタイムスキーマ変更の計画
- 新しいプロジェクトへのマイグレーションツール導入

## 基本原則

1. **すべての変更はマイグレーションで行う** -- 本番データベースを手動で変更しない
2. **本番ではマイグレーションは前方のみ** -- ロールバックには新しい前方マイグレーションを使用
3. **スキーママイグレーションとデータマイグレーションは分離する** -- 1つのマイグレーションにDDLとDMLを混在させない
4. **本番規模のデータでマイグレーションをテストする** -- 100行で動作するマイグレーションが1000万行でロックする可能性がある
5. **デプロイ済みのマイグレーションはイミュータブル** -- 本番で実行されたマイグレーションは編集しない

## マイグレーション安全チェックリスト

マイグレーション適用前に:

- [ ] マイグレーションにUPとDOWNの両方がある（または明示的に不可逆と記載されている）
- [ ] 大きなテーブルでフルテーブルロックがない（並行操作を使用）
- [ ] 新しいカラムにデフォルト値があるかNULL許容（デフォルトなしのNOT NULLは追加しない）
- [ ] インデックスは並行的に作成（既存テーブルではCREATE TABLEとインラインにしない）
- [ ] データバックフィルはスキーマ変更とは別のマイグレーション
- [ ] 本番データのコピーでテスト済み
- [ ] ロールバック計画が文書化されている

## PostgreSQLパターン

### カラムの安全な追加

```sql
-- 良い例: NULL許容カラム、ロックなし
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- 良い例: デフォルト値付きカラム（Postgres 11+は即座に反映、リライトなし）
ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

-- 悪い例: 既存テーブルへのデフォルトなしNOT NULL（フルリライトが必要）
ALTER TABLE users ADD COLUMN role TEXT NOT NULL;
-- テーブルをロックし、すべての行をリライトする
```

### ダウンタイムなしのインデックス追加

```sql
-- 悪い例: 大きなテーブルで書き込みをブロック
CREATE INDEX idx_users_email ON users (email);

-- 良い例: ノンブロッキング、並行書き込みを許可
CREATE INDEX CONCURRENTLY idx_users_email ON users (email);

-- 注意: CONCURRENTLYはトランザクションブロック内では実行できない
-- ほとんどのマイグレーションツールで特別な処理が必要
```

### カラムの名前変更（ゼロダウンタイム）

本番で直接名前変更しない。拡張-縮小パターンを使用する:

```sql
-- ステップ1: 新しいカラムを追加（マイグレーション001）
ALTER TABLE users ADD COLUMN display_name TEXT;

-- ステップ2: データのバックフィル（マイグレーション002、データマイグレーション）
UPDATE users SET display_name = username WHERE display_name IS NULL;

-- ステップ3: アプリケーションコードを更新し両方のカラムを読み書き
-- アプリケーション変更をデプロイ

-- ステップ4: 旧カラムへの書き込みを停止し、削除（マイグレーション003）
ALTER TABLE users DROP COLUMN username;
```

### カラムの安全な削除

```sql
-- ステップ1: アプリケーションからカラムへのすべての参照を削除
-- ステップ2: カラム参照なしのアプリケーションをデプロイ
-- ステップ3: 次のマイグレーションでカラムを削除
ALTER TABLE orders DROP COLUMN legacy_status;

-- Djangoの場合: SeparateDatabaseAndStateを使用してモデルから削除
-- DROP COLUMNを生成せずに（次のマイグレーションで削除）
```

### 大規模データマイグレーション

```sql
-- 悪い例: 1つのトランザクションですべての行を更新（テーブルをロック）
UPDATE users SET normalized_email = LOWER(email);

-- 良い例: 進捗付きバッチ更新
DO $$
DECLARE
  batch_size INT := 10000;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE users
    SET normalized_email = LOWER(email)
    WHERE id IN (
      SELECT id FROM users
      WHERE normalized_email IS NULL
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % rows', rows_updated;
    EXIT WHEN rows_updated = 0;
    COMMIT;
  END LOOP;
END $$;
```

## Prisma (TypeScript/Node.js)

### ワークフロー

```bash
# スキーマ変更からマイグレーションを作成
npx prisma migrate dev --name add_user_avatar

# 本番で保留中のマイグレーションを適用
npx prisma migrate deploy

# データベースをリセット（開発時のみ）
npx prisma migrate reset

# スキーマ変更後にクライアントを生成
npx prisma generate
```

### スキーマの例

```prisma
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  avatarUrl String?  @map("avatar_url")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  orders    Order[]

  @@map("users")
  @@index([email])
}
```

### カスタムSQLマイグレーション

Prismaで表現できない操作（並行インデックス、データバックフィル）の場合:

```bash
# 空のマイグレーションを作成し、SQLを手動で編集
npx prisma migrate dev --create-only --name add_email_index
```

```sql
-- migrations/20240115_add_email_index/migration.sql
-- PrismaはCONCURRENTLYを生成できないため、手動で記述
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users (email);
```

## Drizzle (TypeScript/Node.js)

### ワークフロー

```bash
# スキーマ変更からマイグレーションを生成
npx drizzle-kit generate

# マイグレーションを適用
npx drizzle-kit migrate

# スキーマを直接プッシュ（開発時のみ、マイグレーションファイルなし）
npx drizzle-kit push
```

### スキーマの例

```typescript
import { pgTable, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

## Django (Python)

### ワークフロー

```bash
# モデル変更からマイグレーションを生成
python manage.py makemigrations

# マイグレーションを適用
python manage.py migrate

# マイグレーションの状態を表示
python manage.py showmigrations

# カスタムSQL用の空のマイグレーションを生成
python manage.py makemigrations --empty app_name -n description
```

### データマイグレーション

```python
from django.db import migrations

def backfill_display_names(apps, schema_editor):
    User = apps.get_model("accounts", "User")
    batch_size = 5000
    users = User.objects.filter(display_name="")
    while users.exists():
        batch = list(users[:batch_size])
        for user in batch:
            user.display_name = user.username
        User.objects.bulk_update(batch, ["display_name"], batch_size=batch_size)

def reverse_backfill(apps, schema_editor):
    pass  # データマイグレーション、リバース不要

class Migration(migrations.Migration):
    dependencies = [("accounts", "0015_add_display_name")]

    operations = [
        migrations.RunPython(backfill_display_names, reverse_backfill),
    ]
```

### SeparateDatabaseAndState

データベースからカラムを即座に削除せずにDjangoモデルから削除する:

```python
class Migration(migrations.Migration):
    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveField(model_name="user", name="legacy_field"),
            ],
            database_operations=[],  # DBにはまだ触れない
        ),
    ]
```

## golang-migrate (Go)

### ワークフロー

```bash
# マイグレーションペアを作成
migrate create -ext sql -dir migrations -seq add_user_avatar

# 保留中のすべてのマイグレーションを適用
migrate -path migrations -database "$DATABASE_URL" up

# 最後のマイグレーションをロールバック
migrate -path migrations -database "$DATABASE_URL" down 1

# バージョンを強制（dirty状態の修正）
migrate -path migrations -database "$DATABASE_URL" force VERSION
```

### マイグレーションファイル

```sql
-- migrations/000003_add_user_avatar.up.sql
ALTER TABLE users ADD COLUMN avatar_url TEXT;
CREATE INDEX CONCURRENTLY idx_users_avatar ON users (avatar_url) WHERE avatar_url IS NOT NULL;

-- migrations/000003_add_user_avatar.down.sql
DROP INDEX IF EXISTS idx_users_avatar;
ALTER TABLE users DROP COLUMN IF EXISTS avatar_url;
```

## ゼロダウンタイムマイグレーション戦略

重要な本番変更には、拡張-縮小パターンに従う:

```
フェーズ1: 拡張
  - 新しいカラム/テーブルを追加（NULL許容またはデフォルト値付き）
  - デプロイ: アプリは旧と新の両方に書き込み
  - 既存データをバックフィル

フェーズ2: 移行
  - デプロイ: アプリは新から読み取り、両方に書き込み
  - データの整合性を検証

フェーズ3: 縮小
  - デプロイ: アプリは新のみを使用
  - 旧カラム/テーブルを別のマイグレーションで削除
```

### タイムラインの例

```
1日目: マイグレーションがnew_statusカラムを追加（NULL許容）
1日目: アプリv2をデプロイ — statusとnew_statusの両方に書き込み
2日目: 既存行のバックフィルマイグレーションを実行
3日目: アプリv3をデプロイ — new_statusからのみ読み取り
7日目: マイグレーションで旧statusカラムを削除
```

## アンチパターン

| アンチパターン | 失敗する理由 | より良いアプローチ |
|-------------|------------|-----------------|
| 本番での手動SQL | 監査証跡なし、再現不可能 | 常にマイグレーションファイルを使用 |
| デプロイ済みマイグレーションの編集 | 環境間のドリフトを引き起こす | 代わりに新しいマイグレーションを作成 |
| デフォルトなしのNOT NULL | テーブルロック、すべての行をリライト | NULL許容で追加、バックフィル、その後制約を追加 |
| 大きなテーブルでのインラインインデックス | ビルド中に書き込みをブロック | CREATE INDEX CONCURRENTLY |
| 1つのマイグレーションにスキーマ + データ | ロールバックが困難、長いトランザクション | マイグレーションを分離 |
| コード削除前のカラム削除 | 欠落カラムでアプリケーションエラー | コードを先に削除、次のデプロイでカラムを削除 |
