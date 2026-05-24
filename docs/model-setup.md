---
title: メインLLM 接続セットアップの統一
status: 2026-05-04 提案 / 同日実装
---

# メインLLM接続セットアップ - REPL とウィザードの統一

## 背景

`npm run setup` (= `runSetupWizard`) と REPL の `/model url` / `/model provider` の間に
表記・操作モデルの大きな乖離があり、ユーザーが「同じアプリの設定なのに別物」と
感じる原因になっていた。

具体的には:

- **wizard:** プロバイダー選択 → ホスト or IP → ポート (provider 既定値) → 接続テスト → モデル一覧から選択
- **REPL:** `/model url <フルURL>` で URL 一括書き換え。 接続テストもモデル一覧確認も無し
- 結果として「`/model url http://192.168.1.201:8090` を入れたが `/model list` で何も出ない」
  → ユーザーは「設定が反映されていないのでは？」 と不信感を持つ

llamacpp で複数モデルを別ポートで起動する運用 (8080 以外を使う) は
珍しくないため、ポート指定を含めた接続切替は一級市民として扱う。

## 方針

1. **REPL から設定ウィザードを呼び出せるようにする** — `/model setup` (引数なし) で
   `npm run setup` 相当のローカル系再設定フローを起動。 既存の `/model setup azure-*`
   と同じ命名体系。
2. **表記揺れを解消する** — wizard が「ホスト or IP」 + 「ポート」 を別々に聞く以上、
   REPL 側も同じ単位で設定できるべき。 `/model url` (URL一括) は誤解を招くので
   `/model host <IPまたはホスト名>` + `/model port <番号>` に分離。
3. **接続変更後は確認できるようにする** — host/port を変更したら自動で接続テスト
   + モデル一覧をプレビュー表示。 「設定が効いているか」 の不信感を払拭する。

## REPL コマンド一覧 (改定後)

| コマンド | 役割 |
|---------|-----|
| `/model setup` | ローカル系LLMをウィザードで再設定 (provider/host/port/model 一括) |
| `/model setup azure-foundry` 他 | Azure 系の対話セットアップ (既存) |
| `/model setup anthropic` | Anthropic API (api.anthropic.com) を対話セットアップ (2026-05-18) |
| `/model setup claude-cli` | Claude Code CLI (`claude -p`) を対話セットアップ (2026-05-18)。 詳細: `docs/claude-providers.md` |
| `/model setup gemini` | Google AI Studio (Gemini API) を対話セットアップ (2026-05-24)。 詳細: `docs/gemini-aistudio-provider.md` |
| `/model host <host>` | ホスト or IP のみ変更。 ポート/プロバイダーは保持 |
| `/model port <port>` | ポートのみ変更 |
| `/model provider <type> [<URL>]` | プロバイダー切替 (URL 同時指定可、既存) |
| `/model list` | モデル一覧から対話選択 (既存) |
| `/model <name>` | モデル名直接指定 (既存) |
| `/model url <URL>` | **非推奨**。 互換のため残すが「`/model host` + `/model port`、または `/model setup` を推奨」と案内 |

## setup-wizard.ts のリファクタ

`runSetupWizard()` は現状 `process.exit(1)` で失敗時にプロセスを落とす。 REPL から
呼ぶときは exit されると致命的なので、 内部実装を以下に分割する:

- `pickProvider()` — プロバイダー選択 (inquirer)
- `pickHostPort(providerType)` — host + port 入力
- `connectAndListModels(providerType, baseUrl)` — 接続テスト + モデル一覧取得 (失敗時 throw)
- `pickModel(models)` — モデル選択
- `pickContextWindow(model)` — context window 入力
- `pickDescription()` — 特性説明 (任意)

これらを束ねた `runMainLLMSetup(opts)` を `runSetupWizard()` と REPL `/model setup`
両方から呼ぶ。 失敗時は throw を上に伝播する (REPL 側で catch してメッセージ表示)。

vision LLM 設定は **初回 wizard 専用**。 REPL 再設定時はメインLLMだけ更新して
visionLLM 設定はそのまま残す。

## host/port 変更時の挙動

`/model host <host>` または `/model port <port>` 実行時:

1. baseUrl を `http://<新host>:<port>` で書き換え
2. `applyMainLLMEndpoint()` でプロバイダー実体を再構築
3. 接続テスト (`provider.testConnection()`) — 失敗なら警告表示するが設定は保持
4. 接続成功時はモデル一覧を `provider.listModels()` で取得し件数だけ表示
   - 0 件なら「モデルが見つかりません。 サーバー側のモデル起動状況を確認してください」
   - 1件以上なら「N 個のモデルが利用可能です。 `/model list` で選択できます」

これで「URL を入れたのに list が空」 → 「サーバー側の問題か接続情報の問題かが
即座に分かる」 ようになる。

## 後方互換

- `/model url <URL>` は残す。 ただし実行時に黄色文字で
  「このコマンドは非推奨です。 `/model host` / `/model port` または `/model setup`
  をご利用ください」 と表示。
- 設定ファイル形式は変更なし (`baseUrl` フィールドのまま)。
- `npm run setup` の挙動は変わらず (内部は新しい関数群を使うが UI は同じ)。

## 実装スコープ外

- セカンドLLM (`/second`) 側の表記揺れ統一は本タスクの対象外 (同様の問題はあるが、
  別タスクで対応)。 セカンドLLMには既に `/second setup` がある。
- vision LLM の REPL 再設定 — 利用頻度が低く wizard を直接走らせれば良いので
  本タスクではスコープ外。
