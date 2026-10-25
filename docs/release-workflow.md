# リリース自動ビルド設計 (`.github/workflows/release.yml`)

## 1. 目的

配布 exe (Node.js SEA) は**ビルドに使った Node をそのまま内包する**。Node 本体にセキュリティ修正が出ると、ソースに変更がなくても exe の再ビルドと差し替えが必要になる (経緯: docs/nodejs-security-review-2026-10.md)。

従来はユーザーが手元の Windows 機でビルドしてアップロードしていたため、Node の修正が出てから配布物の差し替えまでが手作業に依存していた。本 workflow は次を満たす。

- Windows 機での手作業なしで、最新パッチ版 Node によるビルド・検査・Release 添付まで行う
- 修正前の Node で作った exe を配布しない (下限チェック)
- 既存 tag の資産を、ソースを変えずに再ビルドして差し替えられる

## 2. 起動条件

| 起動 | 用途 | 動作 |
|---|---|---|
| `v*.*.*` tag の push | 通常のリリース | Release が無ければ作成し、exe と zip を添付 |
| 手動実行 (`workflow_dispatch`, 入力 `tag`)・tag 既存 | Node のセキュリティリリース時の再ビルド | 指定 tag の commit をビルドし、既存 Release の資産を `--clobber` で差し替え。Release が無ければ作成 |
| 手動実行・tag 未作成 | tag を push できない環境からの新規リリース | 実行ブランチ (main) の先頭をビルドし、`gh release create --target <commit>` で tag と Release を同時に作成 |

手動実行は Actions 画面の「Release」→「Run workflow」で tag を入力する。workflow 定義は実行ブランチのものが使われる。

tag 未作成の手動実行を設けた理由: Claude Code の Web 実行環境では git 経由の tag push が拒否されるため (2026-10-22 確認)、tag push を起点にできない場合でも main からリリースできるようにする。

## 3. 処理の流れ (windows-latest)

1. checkout し、tag があればその commit、手動実行で tag が無ければ実行ブランチの先頭をビルド対象に決める (`RELEASE_SHA`)
2. `actions/setup-node` で Node 24 の**最新パッチ版**を取得 (`check-latest: true`)
3. **下限チェック**: `SECURITY_NODE_FLOOR` 未満なら失敗。キャッシュ等で古い Node が使われても修正前 Node の exe を作らない
4. `npm ci` → `validate:version --tag` (tag / package.json / lock / CHANGELOG の整合) → `lint` → `test` → 本番依存の `npm audit`
5. `npm run build:deploy` で `deploy/` を組み立て
6. `scripts/smoke-deploy.ps1 -ExpectedNode <ビルドに使った Node>` で exe の起動・版表示・同梱アセット・`.deploy-meta.json` の Node 版一致を検査 (CI の package-smoke と同じスクリプト)
7. `localllm-v<version>-win-x64.zip` を作成 (exe + skills/ + agents/ + install.bat/sh + README)
8. Release 作成 (ノートは CHANGELOG の該当版セクション + ビルドに使った Node 版 + インストール手順) または資産差し替え

## 4. 運用

### 通常リリース

1. `package.json` / `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`) と `CHANGELOG.md` を更新し、`npm run validate:version -- --tag v<x.y.z>` を通して main へマージ
2. main の該当コミットに `v<x.y.z>` tag を付けて push → workflow が Release を作成 (tag を push できない環境では、main で「Run workflow」に `v<x.y.z>` を入力して実行)

### Node のセキュリティリリースが出たとき

1. `release.yml` の `SECURITY_NODE_FLOOR` を修正版 (例: `24.22.1`) に上げて main へマージ
2. 次のどちらか
   - **推奨**: パッチ版を上げて新しい tag でリリース。更新通知 (`--check-update`) が利用者に届く
   - 急ぎの差し替え: 最新 tag を手動実行で再ビルド。版番号は変わらないため利用者への更新通知は出ない
3. 修正前 Node で作られた旧 Release は、必要に応じて下書き化または資産削除 (GitHub 画面で実施)

## 5. 制約・判断

- **コード署名なし**: 従来どおり無署名 (docs/archive/production-readiness.md の判断を継承)
- **権限**: `contents: write` のみ。Release 作成・資産アップロードに `GITHUB_TOKEN` を使う
- **同一 tag の同時実行**: `concurrency` で直列化
- **CI との関係**: CI (`ci.yml`) も Node 24 の最新パッチ版で実行し、package-smoke は同じ `scripts/smoke-deploy.ps1` を使う
