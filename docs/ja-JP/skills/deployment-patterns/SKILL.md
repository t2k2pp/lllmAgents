---
name: deployment-patterns
description: Deployment workflows, CI/CD pipeline patterns, Docker containerization, health checks, rollback strategies, and production readiness checklists for web applications.
origin: ECC
---

# デプロイメントパターン

本番デプロイメントのワークフローとCI/CDのベストプラクティス。

## 発動条件

- CI/CDパイプラインのセットアップ
- アプリケーションのDocker化
- デプロイメント戦略の計画（Blue-Green、カナリア、ローリング）
- ヘルスチェックとレディネスプローブの実装
- 本番リリースの準備
- 環境固有の設定の構成

## デプロイメント戦略

### ローリングデプロイメント（デフォルト）

インスタンスを段階的に置換する。ロールアウト中は旧バージョンと新バージョンが同時に稼働する。

```
Instance 1: v1 → v2  (最初に更新)
Instance 2: v1        (まだv1で稼働中)
Instance 3: v1        (まだv1で稼働中)

Instance 1: v2
Instance 2: v1 → v2  (2番目に更新)
Instance 3: v1

Instance 1: v2
Instance 2: v2
Instance 3: v1 → v2  (最後に更新)
```

**メリット:** ゼロダウンタイム、段階的なロールアウト
**デメリット:** 2つのバージョンが同時に稼働する -- 後方互換性のある変更が必要
**使用場面:** 標準的なデプロイメント、後方互換性のある変更

### Blue-Greenデプロイメント

2つの同一環境を稼働させる。トラフィックをアトミックに切り替える。

```
Blue  (v1) ← トラフィック
Green (v2)   アイドル、新バージョンを実行中

# 検証後:
Blue  (v1)   アイドル（スタンバイになる）
Green (v2) ← トラフィック
```

**メリット:** 即時ロールバック（Blueに切り戻し）、クリーンなカットオーバー
**デメリット:** デプロイメント中に2倍のインフラが必要
**使用場面:** 重要なサービス、問題への耐性がゼロの場合

### カナリアデプロイメント

新バージョンに少量のトラフィックを最初にルーティングする。

```
v1: 95%のトラフィック
v2:  5%のトラフィック  (カナリア)

# メトリクスが良好であれば:
v1: 50%のトラフィック
v2: 50%のトラフィック

# 最終:
v2: 100%のトラフィック
```

**メリット:** フルロールアウト前に実トラフィックで問題を検知
**デメリット:** トラフィック分割インフラとモニタリングが必要
**使用場面:** 高トラフィックサービス、リスクの高い変更、フィーチャーフラグ

## Docker

### マルチステージDockerfile (Node.js)

```dockerfile
# Stage 1: Install dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Stage 2: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN npm prune --production

# Stage 3: Production image
FROM node:22-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001
USER appuser

COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/package.json ./

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
```

### マルチステージDockerfile (Go)

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /server ./cmd/server

FROM alpine:3.19 AS runner
RUN apk --no-cache add ca-certificates
RUN adduser -D -u 1001 appuser
USER appuser

COPY --from=builder /server /server

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["/server"]
```

### マルチステージDockerfile (Python/Django)

```dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt

FROM python:3.12-slim AS runner
WORKDIR /app

RUN useradd -r -u 1001 appuser
USER appuser

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY . .

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health/')" || exit 1
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "4"]
```

### Dockerベストプラクティス

```
# 良いプラクティス
- 特定のバージョンタグを使用する（node:22-alpine、node:latestではなく）
- マルチステージビルドでイメージサイズを最小化する
- 非rootユーザーで実行する
- 依存関係ファイルを先にコピーする（レイヤーキャッシュ）
- .dockerignoreを使用してnode_modules、.git、testsを除外する
- HEALTHCHECK命令を追加する
- docker-composeまたはk8sでリソース制限を設定する

# 悪いプラクティス
- rootで実行する
- :latestタグを使用する
- リポジトリ全体を1つのCOPYレイヤーでコピーする
- 本番イメージに開発依存関係をインストールする
- イメージにシークレットを保存する（環境変数またはシークレットマネージャーを使用）
```

## CI/CDパイプライン

### GitHub Actions（標準パイプライン）

```yaml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test -- --coverage
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: coverage/

  build:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    environment: production
    steps:
      - name: Deploy to production
        run: |
          # プラットフォーム固有のデプロイメントコマンド
          # Railway: railway up
          # Vercel: vercel --prod
          # K8s: kubectl set image deployment/app app=ghcr.io/${{ github.repository }}:${{ github.sha }}
          echo "Deploying ${{ github.sha }}"
```

### パイプラインステージ

```
PRオープン時:
  lint → typecheck → ユニットテスト → インテグレーションテスト → プレビューデプロイ

mainにマージ時:
  lint → typecheck → ユニットテスト → インテグレーションテスト → イメージビルド → ステージングデプロイ → スモークテスト → 本番デプロイ
```

## ヘルスチェック

### ヘルスチェックエンドポイント

```typescript
// シンプルなヘルスチェック
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// 詳細なヘルスチェック（内部モニタリング用）
app.get("/health/detailed", async (req, res) => {
  const checks = {
    database: await checkDatabase(),
    redis: await checkRedis(),
    externalApi: await checkExternalApi(),
  };

  const allHealthy = Object.values(checks).every(c => c.status === "ok");

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION || "unknown",
    uptime: process.uptime(),
    checks,
  });
});

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await db.query("SELECT 1");
    return { status: "ok", latency_ms: 2 };
  } catch (err) {
    return { status: "error", message: "Database unreachable" };
  }
}
```

### Kubernetesプローブ

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 2

startupProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 0
  periodSeconds: 5
  failureThreshold: 30    # 30 * 5s = 最大150秒の起動時間
```

## 環境設定

### Twelve-Factor Appパターン

```bash
# すべての設定は環境変数で -- コードには書かない
DATABASE_URL=postgres://user:pass@host:5432/db
REDIS_URL=redis://host:6379/0
API_KEY=${API_KEY}           # シークレットマネージャーで注入
LOG_LEVEL=info
PORT=3000

# 環境固有の動作
NODE_ENV=production          # またはstaging、development
APP_ENV=production           # 明示的なアプリ環境
```

### 設定バリデーション

```typescript
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

// 起動時にバリデーション -- 設定が不正なら即座に失敗
export const env = envSchema.parse(process.env);
```

## ロールバック戦略

### 即時ロールバック

```bash
# Docker/Kubernetes: 前のイメージを指定
kubectl rollout undo deployment/app

# Vercel: 前のデプロイメントを昇格
vercel rollback

# Railway: 前のコミットを再デプロイ
railway up --commit <previous-sha>

# データベース: マイグレーションをロールバック（可逆の場合）
npx prisma migrate resolve --rolled-back <migration-name>
```

### ロールバックチェックリスト

- [ ] 前のイメージ/アーティファクトが利用可能でタグ付けされている
- [ ] データベースマイグレーションが後方互換性がある（破壊的変更なし）
- [ ] フィーチャーフラグでデプロイなしに新機能を無効化できる
- [ ] エラー率スパイクのモニタリングアラートが設定されている
- [ ] 本番リリース前にステージングでロールバックをテスト済み

## 本番準備チェックリスト

本番デプロイメントの前に:

### アプリケーション
- [ ] すべてのテストが通過（ユニット、インテグレーション、E2E）
- [ ] コードや設定ファイルにハードコードされたシークレットがない
- [ ] エラーハンドリングがすべてのエッジケースをカバー
- [ ] ログが構造化（JSON）されており、PIIを含まない
- [ ] ヘルスチェックエンドポイントが意味のあるステータスを返す

### インフラストラクチャ
- [ ] Dockerイメージが再現可能にビルドされる（バージョン固定）
- [ ] 環境変数が文書化され、起動時にバリデーションされる
- [ ] リソース制限が設定されている（CPU、メモリ）
- [ ] 水平スケーリングが設定されている（最小/最大インスタンス）
- [ ] すべてのエンドポイントでSSL/TLSが有効

### モニタリング
- [ ] アプリケーションメトリクスがエクスポートされている（リクエスト率、レイテンシ、エラー）
- [ ] エラー率 > 閾値のアラートが設定されている
- [ ] ログ集約が設定されている（構造化ログ、検索可能）
- [ ] ヘルスエンドポイントの稼働時間モニタリング

### セキュリティ
- [ ] 依存関係のCVEスキャン済み
- [ ] CORSが許可されたオリジンのみに設定されている
- [ ] 公開エンドポイントでレート制限が有効
- [ ] 認証と認可が検証済み
- [ ] セキュリティヘッダーが設定されている（CSP、HSTS、X-Frame-Options）

### 運用
- [ ] ロールバック計画が文書化され、テスト済み
- [ ] データベースマイグレーションが本番規模のデータでテスト済み
- [ ] 一般的な障害シナリオのランブック
- [ ] オンコールローテーションとエスカレーションパスが定義済み
