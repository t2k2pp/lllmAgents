# Node.js セキュリティ調査メモ（2026-10-22 時点）

本メモは 2 部構成。

- **Part A（汎用）**: Node.js 本体の直近脆弱性と、任意の Node.js プロジェクトで使える確認手順。他プロジェクトでも流用可
- **Part B（lllmAgents 固有）**: 本アプリへの影響確認結果と対応案

情報源は Node.js 公式ブログ（Vulnerability カテゴリ）を一次情報とする。公式に記載のない部分（攻撃成立条件など）は「推定」と明記する。

---

## Part A. 汎用: Node.js 本体の脆弱性（2026 年）

### A-1. 現在の修正版（2026-10-21 リリース）

| 系列 | 修正版（これ以上を使う） | 状態 |
|---|---|---|
| 26.x | v26.12.1 | Current |
| 24.x | v24.22.1 | LTS |
| 22.x | v22.23.4 | LTS |
| 20.x 以前 | なし | **EOL（20.x は 2026-04-30 終了）**。公式は「EOL 版はセキュリティリリースのたびに常に影響あり」としている |

最新版は過去のセキュリティリリースの修正をすべて含むため、**「最新パッチ版に上げる」で 2026 年分は一括で解消**する。

### A-2. 2026 年のセキュリティリリース一覧

| 日付 | 修正版 | 件数 | 主な High |
|---|---|---|---|
| 2026-10-21 | 22.23.4 / 24.22.1 / 26.12.1 | 10 | Brotli 展開の OOB 書込みによる RCE、TLS ホスト名検証バイパス×2、`dns.resolve` の NUL 切詰め |
| 2026-07-29 | 22.23.2 / 24.18.1 / 26.5.1 | 11 | HTTP/2 use-after-free・メモリ制限回避、Permission Model の過剰許可 |
| 2026-06-18 | 22.23.0 / 24.17.0 / 26.3.1 | 12 | WebCrypto AES の整数オーバーフロー(DoS)、TLS ワイルドカード深さ認証バイパス |
| 2026-03-24 | 20.20.2 / 22.22.2 / 24.14.1 / 25.8.2 | 9 | `__proto__` ヘッダでプロセスクラッシュ、`SNICallback` 例外による DoS（1 月修正の不完全修正） |

### A-3. 2026-10-21 リリースの CVE 詳細

| CVE | 深刻度 | 内容 | 影響系列 | 該当しやすい使い方（タイトルからの推定） |
|---|---|---|---|---|
| CVE-2026-111497 | High | Brotli デコーダの範囲外書込み → RCE | 22/24/26 | `zlib` の Brotli 展開。**`fetch()` は `Content-Encoding: br` を自動展開するため、外部サーバへの fetch でも到達しうる** |
| CVE-2026-105482 | High | `dns.resolve` が NUL 文字を含む名前を切り詰める | 22/24/26 | 外部入力のホスト名を DNS 解決する処理 |
| CVE-2026-105483 | High | IP を全角数字で書くと TLS 証明書ホスト名検証をバイパス | 24/26 | TLS クライアント |
| CVE-2026-106069 | High | ホストが緩く IP に解決される場合の TLS ホスト名検証バイパス | 22/24/26 | TLS クライアント |
| CVE-2026-105481 | Medium | keep-alive ソケットがリクエスト送信前に書かれたレスポンスを処理 | 22/24/26 | HTTP クライアント（keep-alive） |
| CVE-2026-106072 | Medium | 非正規 IPv4 表記で DNS SAN が IP エンドポイントを認証してしまう | 22/24/26 | TLS クライアント |
| CVE-2026-106074 | Medium | `crypto.randomUUID()` / `randomInt()` のエントロピーキャッシュがスタートアップスナップショット/SEA に保存され、毎回同じ値になる | 22/24/26 | スナップショットや SEA（単一実行ファイル）で配布するアプリ |
| CVE-2026-106070 | Low | ZipFile がヘッダ検証失敗後に攻撃者制御のバイトを返す | 26 | ZIP 読込 |
| CVE-2026-106071 | Low | Permission Model のワイルドカードによる FS 過剰許可 | 26 | `--permission` 利用時 |
| CVE-2026-106073 | Low | `fs.realpathSync` による Permission Model バイパス | 22/24/26 | `--permission` 利用時 |

同梱依存の更新: c-ares、CA 証明書（eMudhra 中間 CA 侵害対応）、OpenSSL（22/24）、SQLite（22）、Undici（全系列）。

### A-4. 過去リリースで比較的影響範囲の広いもの（参考）

- **2026-07**: HTTPS Agent のセッション再利用でホスト名検証がスキップ（CVE-2026-58040, Medium）、HTTP パーサのヘッダ切詰めによるリクエストスマグリング（CVE-2026-58044, Low）、`node:zlib` 同期 API のクラッシュ（CVE-2026-58045, Medium）
- **2026-06**: プロキシ認証情報が `ERR_PROXY_TUNNEL` エラーに漏えい（CVE-2026-48615）、TLS セッション再利用で別 servername の検証をバイパス（CVE-2026-48934, 公式は Medium）、埋込み NUL ホスト名によるリバインディング（CVE-2026-48930）
- **2026-03**: HTTP サーバで `__proto__` ヘッダによるクラッシュ（CVE-2026-21710, High）、HMAC 検証のタイミングサイドチャネル（CVE-2026-21713）、V8 の HashDoS（CVE-2026-21717）

### A-5. 他プロジェクトで影響確認するときのチェックリスト

1. **実行時の Node バージョンを特定する**
   - サーバ/CLI: 本番環境の `node -v`
   - Docker: ベースイメージのタグ（`node:20` 等の EOL 系列が残っていないか）
   - **SEA / pkg / nexe などで exe 化している場合: ビルド時の Node がそのまま埋め込まれる**。修正版 Node で再ビルド・再配布が必要
   - Electron: Node は Electron 側に同梱。Electron のリリースノートで対応 Node を確認
2. **CI の Node バージョン**: `.github/workflows/*.yml` の `node-version`、`.nvmrc`、`.node-version`、`package.json` の `engines`
3. **影響 API の利用有無を grep**（例）
   ```sh
   grep -rn "fetch(\|from \"undici\"\|zlib\|Brotli" src   # Brotli RCE
   grep -rn "node:dns\|dns\.resolve" src                 # DNS
   grep -rn "node:https\|node:tls\|servername" src       # TLS 検証
   grep -rn "randomUUID\|randomInt" src                  # SEA/スナップショット配布時
   grep -rn "node:http2" src                             # HTTP/2
   grep -rn "\-\-permission" .                           # Permission Model
   ```
4. **npm 依存の脆弱性**: `npm audit --omit=dev`（本番依存）と `npm audit`（全体）。Node 本体の脆弱性は npm audit では検出されない点に注意
5. **判定**: 影響 API を使っていなくても、EOL 系列や修正前バージョンを使っていればアップデート対象とする（攻撃条件が公式に未公開の CVE が多いため）

---

## Part B. lllmAgents への影響確認結果

調査時点のリポジトリ: version 0.5.2（`package.json`）。

### B-1. Node バージョン関連

| 対象 | 現状 | 判定 |
|---|---|---|
| exe（`deploy/localllm.exe`） | `build-exe.js` + `scripts/sea-node.js` が**ビルド実行中の Node を SEA に埋め込む** | **影響あり**。修正版未満の Node でビルドした exe は脆弱。修正版 Node で `npm run build:deploy` し直して再配布が必要 |
| CI（`.github/workflows/ci.yml` の test / package-smoke） | `node-version: 20` | **EOL 系列**。exe スモークも Node 20 でビルドしている |
| `package.json` `engines` | `>=20.0.0` | EOL 系列を許容 |
| 調査用コンテナの Node | v22.22.0 | 修正版（22.23.4）未満。ユーザーのローカル環境とは別 |

### B-2. 影響 API の利用状況

| CVE 領域 | 該当コード | 判定 |
|---|---|---|
| Brotli RCE | `fetch()` を `src/tools/definitions/web-search.ts`（DuckDuckGo 等）、`src/utils/update-check.ts`（GitHub API）、各 provider で使用 | **到達経路あり（推定）**。主に信頼できる接続先だが、悪意あるサーバやリダイレクト経由の可能性は否定できない |
| 同上 | `src/security/public-http.ts`（`web_fetch`） | `node:http(s)` 直接利用で自動展開なし → **非該当（推定）** |
| TLS ホスト名検証 | `public-http.ts` は DNS 解決した IP に接続し `servername` で検証。ホスト名は WHATWG `URL` で正規化済み | 影響は限定的と推定（完全否定は不可） |
| DNS | `src/security/sandbox-proxy.ts` は `dns.lookup` を使用（`dns.resolve` ではない） | 直接該当は低いと推定 |
| SEA の `randomUUID` | `src/agent/durable-run-checkpoint.ts`、`src/config/model-registry.ts`、`src/image/comfyui.ts` で使用。SEA 設定で `useSnapshot` は未使用 | 起動時にコードを実行する方式のため該当しにくいと推定。公式に条件記載がなく**未確定** |
| Permission Model | アプリ本体では未使用 | 非該当 |

### B-3. npm 依存（`npm audit`、lockfile ベース）

| パッケージ | 版 | 深刻度 | 経路 | 内容 |
|---|---|---|---|---|
| follow-redirects | 1.16.0 | High | `@slack/bolt` → `axios`（本番依存） | クロスオリジン時の認証ヘッダ除去バイパス（GHSA-q3jh-wrc6-jgq8）、`sensitiveHeaders` 正規表現の不備（GHSA-8r9p-f939-6h3c）。Slack 連携利用時に関係 |

`undici`（直接依存, 7.30.1）は npm audit 上は既知脆弱性なし。

### B-4. 対応状況（2026-10-22 更新）

| # | 対応 | 状態 |
|---|---|---|
| 1 | 修正版 Node で exe を再ビルド・再配布 | **実施済み**。`release.yml` (docs/release-workflow.md) を 2026-10-22 14:36 UTC に手動実行し、v0.5.3 Release (commit 2176d98) を作成。GitHub Actions windows-latest + Node v24.22.1 でビルドし、exe 埋め込み Node 版の一致をスモーク検査で確認。資産: `localllm.exe` / `localllm-v0.5.3-win-x64.zip` |
| 1b | 修正前 Node で作った v0.5.1 / v0.5.2 Release の配布停止 | **実施済み**（2026-10-22 14:17–14:18 UTC にユーザーが両 Release の添付資産を削除。Release ページは公開のまま）。削除前のダウンロード数は全資産 0 |
| 2 | CI の `node-version` を 20 → 24、`engines.node` を `>=22.0.0`、`build-exe.sh` の最低バージョンチェックを 22 に、README / `docs/external_design.md` の要件記載を更新 | 実施済み |
| 3 | `npm audit fix` で follow-redirects を 1.16.0 → 1.16.1 に更新（`npm audit --omit=dev` で 0 件を確認） | 実施済み |
| 4 | ビルド用 Node が修正版以上かのチェック | `release.yml` の `SECURITY_NODE_FLOOR` として実装（ローカルの `build-exe.js` には未追加） |

Node 24.22.1 での検証結果（Linux コンテナ）: `npm run lint` 成功、`npm run test:e2e` 成功、`npm run build:deploy` で SEA 生成・`--version` 起動成功。`npm run test:coverage` は `tests/security/containment.test.ts` の 2 件が失敗したが、変更前コード・Node 22 でも同一に失敗し、コンテナに `bwrap` が無いことによる環境依存（CI の Ubuntu は `bwrap` を導入済み）。

---

## 参考（一次情報）

- Node.js — October 21, 2026 Security Releases: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
- Node.js — July 29, 2026 Security Releases: https://nodejs.org/en/blog/vulnerability/july-2026-security-releases
- Node.js — June 18, 2026 Security Releases: https://nodejs.org/en/blog/vulnerability/june-2026-security-releases
- Node.js — March 24, 2026 Security Releases: https://nodejs.org/en/blog/vulnerability/march-2026-security-releases
- Node.js Vulnerability blog: https://nodejs.org/en/blog/vulnerability
- GHSA-q3jh-wrc6-jgq8 / GHSA-8r9p-f939-6h3c（follow-redirects）: https://github.com/advisories/GHSA-q3jh-wrc6-jgq8 , https://github.com/advisories/GHSA-8r9p-f939-6h3c
