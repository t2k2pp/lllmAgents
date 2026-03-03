---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---
# TypeScript/JavaScript コーディングスタイル

> このファイルは [common/coding-style.md](../common/coding-style.md) を TypeScript/JavaScript 固有のコンテンツで拡張します。

## 不変性

不変更新にはスプレッド演算子を使用してください:

```typescript
// 誤り: ミューテーション
function updateUser(user, name) {
  user.name = name  // ミューテーション!
  return user
}

// 正解: 不変性
function updateUser(user, name) {
  return {
    ...user,
    name
  }
}
```

## エラーハンドリング

async/await と try-catch を使用してください:

```typescript
try {
  const result = await riskyOperation()
  return result
} catch (error) {
  console.error('Operation failed:', error)
  throw new Error('Detailed user-friendly message')
}
```

## 入力検証

スキーマベースの検証に Zod を使用してください:

```typescript
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150)
})

const validated = schema.parse(input)
```

## Console.log

- 本番コードに `console.log` 文を入れない
- 代わりに適切なロギングライブラリを使用
- 自動検出については hooks を参照
