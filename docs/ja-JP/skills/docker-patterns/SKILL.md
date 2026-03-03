---
name: docker-patterns
description: Docker and Docker Compose patterns for local development, container security, networking, volume strategies, and multi-service orchestration.
origin: ECC
---

# Dockerパターン

コンテナ化開発のためのDockerとDocker Composeのベストプラクティス。

## 発動条件

- ローカル開発用のDocker Composeセットアップ
- マルチコンテナアーキテクチャの設計
- コンテナネットワーキングやボリュームの問題のトラブルシューティング
- Dockerfileのセキュリティとサイズのレビュー
- ローカル開発からコンテナ化ワークフローへの移行

## ローカル開発用Docker Compose

### 標準的なWebアプリスタック

```yaml
# docker-compose.yml
services:
  app:
    build:
      context: .
      target: dev                     # マルチステージDockerfileのdevステージを使用
    ports:
      - "3000:3000"
    volumes:
      - .:/app                        # ホットリロード用バインドマウント
      - /app/node_modules             # 匿名ボリューム -- コンテナの依存関係を保持
    environment:
      - DATABASE_URL=postgres://postgres:postgres@db:5432/app_dev
      - REDIS_URL=redis://redis:6379/0
      - NODE_ENV=development
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
    command: npm run dev

  db:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app_dev
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data

  mailpit:                            # ローカルメールテスト
    image: axllent/mailpit
    ports:
      - "8025:8025"                   # Web UI
      - "1025:1025"                   # SMTP

volumes:
  pgdata:
  redisdata:
```

### 開発用と本番用のDockerfile

```dockerfile
# Stage: dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage: dev（ホットリロード、デバッグツール）
FROM node:22-alpine AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# Stage: build
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --production

# Stage: production（最小イメージ）
FROM node:22-alpine AS production
WORKDIR /app
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001
USER appuser
COPY --from=build --chown=appuser:appgroup /app/dist ./dist
COPY --from=build --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=build --chown=appuser:appgroup /app/package.json ./
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
```

### オーバーライドファイル

```yaml
# docker-compose.override.yml（自動読み込み、開発専用設定）
services:
  app:
    environment:
      - DEBUG=app:*
      - LOG_LEVEL=debug
    ports:
      - "9229:9229"                   # Node.jsデバッガー

# docker-compose.prod.yml（本番用に明示的に指定）
services:
  app:
    build:
      target: production
    restart: always
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
```

```bash
# 開発（オーバーライドを自動読み込み）
docker compose up

# 本番
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## ネットワーキング

### サービスディスカバリ

同じComposeネットワーク内のサービスはサービス名で名前解決できる:
```
# "app"コンテナからの場合:
postgres://postgres:postgres@db:5432/app_dev    # "db"はdbコンテナに解決される
redis://redis:6379/0                             # "redis"はredisコンテナに解決される
```

### カスタムネットワーク

```yaml
services:
  frontend:
    networks:
      - frontend-net

  api:
    networks:
      - frontend-net
      - backend-net

  db:
    networks:
      - backend-net              # apiからのみ到達可能、frontendからは不可

networks:
  frontend-net:
  backend-net:
```

### 必要なものだけを公開

```yaml
services:
  db:
    ports:
      - "127.0.0.1:5432:5432"   # ホストからのみアクセス可能、ネットワークからは不可
    # 本番ではportsを完全に省略 -- Dockerネットワーク内でのみアクセス可能
```

## ボリューム戦略

```yaml
volumes:
  # 名前付きボリューム: コンテナの再起動間で永続化、Dockerが管理
  pgdata:

  # バインドマウント: ホストディレクトリをコンテナにマッピング（開発用）
  # - ./src:/app/src

  # 匿名ボリューム: バインドマウントのオーバーライドからコンテナ生成コンテンツを保持
  # - /app/node_modules
```

### 一般的なパターン

```yaml
services:
  app:
    volumes:
      - .:/app                   # ソースコード（ホットリロード用バインドマウント）
      - /app/node_modules        # ホストからコンテナのnode_modulesを保護
      - /app/.next               # ビルドキャッシュを保護

  db:
    volumes:
      - pgdata:/var/lib/postgresql/data          # 永続データ
      - ./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql  # 初期化スクリプト
```

## コンテナセキュリティ

### Dockerfileハードニング

```dockerfile
# 1. 特定のタグを使用する（:latestは使わない）
FROM node:22.12-alpine3.20

# 2. 非rootで実行する
RUN addgroup -g 1001 -S app && adduser -S app -u 1001
USER app

# 3. ケーパビリティを削除する（composeで設定）
# 4. 可能な限り読み取り専用ルートファイルシステム
# 5. イメージレイヤーにシークレットを含めない
```

### Composeセキュリティ

```yaml
services:
  app:
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
      - /app/.cache
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE          # 1024未満のポートにバインドする場合のみ
```

### シークレット管理

```yaml
# 良い例: 環境変数を使用する（実行時に注入）
services:
  app:
    env_file:
      - .env                     # .envはgitにコミットしない
    environment:
      - API_KEY                  # ホスト環境から継承

# 良い例: Dockerシークレット（Swarmモード）
secrets:
  db_password:
    file: ./secrets/db_password.txt

services:
  db:
    secrets:
      - db_password

# 悪い例: イメージにハードコード
# ENV API_KEY=sk-proj-xxxxx      # 絶対にやらない
```

## .dockerignore

```
node_modules
.git
.env
.env.*
dist
coverage
*.log
.next
.cache
docker-compose*.yml
Dockerfile*
README.md
tests/
```

## デバッグ

### 一般的なコマンド

```bash
# ログの表示
docker compose logs -f app           # appログをフォロー
docker compose logs --tail=50 db     # dbの最後の50行

# 実行中のコンテナでコマンドを実行
docker compose exec app sh           # appにシェルで入る
docker compose exec db psql -U postgres  # postgresに接続

# 検査
docker compose ps                     # 稼働中のサービス
docker compose top                    # 各コンテナ内のプロセス
docker stats                          # リソース使用量

# リビルド
docker compose up --build             # イメージをリビルド
docker compose build --no-cache app   # フルリビルドを強制

# クリーンアップ
docker compose down                   # コンテナを停止して削除
docker compose down -v                # ボリュームも削除（破壊的）
docker system prune                   # 未使用のイメージ/コンテナを削除
```

### ネットワーク問題のデバッグ

```bash
# コンテナ内でのDNS名前解決を確認
docker compose exec app nslookup db

# 接続性を確認
docker compose exec app wget -qO- http://api:3000/health

# ネットワークを検査
docker network ls
docker network inspect <project>_default
```

## アンチパターン

```
# 悪い例: オーケストレーションなしで本番でdocker composeを使用
# 本番のマルチコンテナワークロードにはKubernetes、ECS、またはDocker Swarmを使用

# 悪い例: ボリュームなしでコンテナにデータを保存
# コンテナはエフェメラル -- ボリュームなしでは再起動時にすべてのデータが失われる

# 悪い例: rootで実行
# 常に非rootユーザーを作成して使用

# 悪い例: :latestタグを使用
# 再現可能なビルドのために特定のバージョンに固定

# 悪い例: すべてのサービスを1つの巨大なコンテナに入れる
# 関心の分離: コンテナごとに1つのプロセス

# 悪い例: docker-compose.ymlにシークレットを書く
# .envファイル（gitignore済み）またはDockerシークレットを使用
```
