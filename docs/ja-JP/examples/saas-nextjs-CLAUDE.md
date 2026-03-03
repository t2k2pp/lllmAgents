# SaaS アプリケーション — プロジェクト CLAUDE.md

> Next.js + Supabase + Stripe を使用した SaaS アプリケーションの実際のプロジェクト例。
> プロジェクトルートにコピーし、技術スタックに合わせてカスタマイズしてください。

## プロジェクト概要

**技術スタック:** Next.js 15（App Router）、TypeScript、Supabase（認証 + DB）、Stripe（課金）、Tailwind CSS、Playwright（E2E）

**アーキテクチャ:** デフォルトで Server Components を使用。Client Components はインタラクティビティが必要な場合のみ。Webhook には API ルート、ミューテーションには Server Actions を使用。

## 必須ルール

### データベース

- すべてのクエリは RLS 有効の Supabase クライアントを使用 — RLS をバイパスしない
- マイグレーションは `supabase/migrations/` に配置 — データベースを直接変更しない
- `select('*')` ではなく、明示的なカラムリスト付きの `select()` を使用
- すべてのユーザー向けクエリに `.limit()` を含める — 無制限の結果を防止

### 認証

- Server Components では `@supabase/ssr` の `createServerClient()` を使用
- Client Components では `@supabase/ssr` の `createBrowserClient()` を使用
- 保護されたルートは `getUser()` をチェック — 認証に `getSession()` だけを信頼しない
- `middleware.ts` のミドルウェアが毎リクエストで認証トークンをリフレッシュ

### 課金

- Stripe webhook ハンドラーは `app/api/webhooks/stripe/route.ts` に配置
- クライアント側の価格データを信頼しない — 常にサーバー側で Stripe から取得
- サブスクリプションステータスは `subscription_status` カラムで確認、webhook で同期
- フリーティアユーザー: 3プロジェクト、100 API コール/日

### コードスタイル

- コードやコメントに絵文字を使用しない
- 不変パターンのみ — スプレッド演算子を使用、ミューテーションしない
- Server Components: `'use client'` ディレクティブなし、`useState`/`useEffect` なし
- Client Components: 先頭に `'use client'`、最小限に — ロジックはフックに抽出
- すべての入力検証（API ルート、フォーム、環境変数）に Zod スキーマを優先

## ファイル構造

```
src/
  app/
    (auth)/          # 認証ページ（ログイン、サインアップ、パスワードリセット）
    (dashboard)/     # 保護されたダッシュボードページ
    api/
      webhooks/      # Stripe、Supabase webhook
    layout.tsx       # プロバイダー付きルートレイアウト
  components/
    ui/              # Shadcn/ui コンポーネント
    forms/           # バリデーション付きフォームコンポーネント
    dashboard/       # ダッシュボード固有のコンポーネント
  hooks/             # カスタム React フック
  lib/
    supabase/        # Supabase クライアントファクトリ
    stripe/          # Stripe クライアントとヘルパー
    utils.ts         # 汎用ユーティリティ
  types/             # 共有 TypeScript 型
supabase/
  migrations/        # データベースマイグレーション
  seed.sql           # 開発用シードデータ
```

## 主要パターン

### API レスポンスフォーマット

```typescript
type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string }
```

### Server Action パターン

```typescript
'use server'

import { z } from 'zod'
import { createServerClient } from '@/lib/supabase/server'

const schema = z.object({
  name: z.string().min(1).max(100),
})

export async function createProject(formData: FormData) {
  const parsed = schema.safeParse({ name: formData.get('name') })
  if (!parsed.success) {
    return { success: false, error: parsed.error.flatten() }
  }

  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  const { data, error } = await supabase
    .from('projects')
    .insert({ name: parsed.data.name, user_id: user.id })
    .select('id, name, created_at')
    .single()

  if (error) return { success: false, error: 'Failed to create project' }
  return { success: true, data }
}
```

## 環境変数

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=     # サーバー専用、クライアントに公開しない

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

# アプリ
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## テスト戦略

```bash
/tdd                    # 新機能のユニット + 統合テスト
/e2e                    # 認証フロー、課金、ダッシュボードの Playwright テスト
/test-coverage          # 80%+ カバレッジを確認
```

### 重要な E2E フロー

1. サインアップ → メール確認 → 最初のプロジェクト作成
2. ログイン → ダッシュボード → CRUD 操作
3. プランアップグレード → Stripe チェックアウト → サブスクリプション有効
4. Webhook: サブスクリプションキャンセル → フリーティアにダウングレード

## ECC ワークフロー

```bash
# 機能の計画
/plan "Add team invitations with email notifications"

# TDD で開発
/tdd

# コミット前
/code-review
/security-scan

# リリース前
/e2e
/test-coverage
```

## Git ワークフロー

- `feat:` 新機能、`fix:` バグ修正、`refactor:` コード変更
- `main` からフィーチャーブランチ、PR 必須
- CI で実行: リント、型チェック、ユニットテスト、E2E テスト
- デプロイ: PR で Vercel プレビュー、`main` マージで本番
