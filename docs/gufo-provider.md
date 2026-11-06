# Gufo プロバイダ (`providerType: "gufo"`)

2026-11-06。 利用者の指摘「Gufo も使っている。 フォールバックは嫌い」 から。

## 1. 背景

Gufo (https://github.com/gufo-org/gufo 、 `docs/SERVER.md`) はローカルの推論サーバー。
llama-server と同じ形の `/health`・`/props`・`/models` も返すので、 これまでは `llamacpp` として登録して動いていた。

ただし `llamacpp` の実装は llama.cpp 向けで、

- Gufo 自身の項目 (`/v1/models` の `context_length`・`architecture.input_modalities`) を読まない
- `/props` が取れないと、 黙って `n_ctx_train` → モデル名からの推測へ切り替える (`inferContextLength`)

ため、 Gufo の版が変わって llama.cpp の真似が崩れた時に、 推測の枠で動いてしまい気付けない。
Gufo を独自の種類として足し、 Gufo が文書で約束する値だけを読み、 取れない時は止める。

## 2. 使うエンドポイント

| 目的 | エンドポイント | 読む項目 |
|---|---|---|
| 接続の確認 | `GET /health` | 200 か |
| モデル一覧・画像対応 | `GET /v1/models` | `data[].id`・`data[].architecture.input_modalities` に `"image"` |
| 1 セッションの枠 | `GET /props` | `default_generation_settings.n_ctx` |
| 会話 | `POST /v1/chat/completions` | OpenAI 互換 (他のローカルと同じ処理) |

- 枠は `/props` の `n_ctx` (1 セッションで実際に使える値) を使う。 `/v1/models` の `context_length` は使わない (2 つの出所を持たない)。
- 思考オフは `chat_template_kwargs.enable_thinking: false` (Gufo が受け付ける。 llama.cpp・vLLM と同じ)。
- 既定のポートは 8080 (Gufo の文書に既定値の記載が無く、 例が 8080 のため)。
- Anthropic Messages (`/v1/messages`) は今は使わない (要る時に別の種類として足す)。

## 3. 取れない時 (フォールバックしない)

| 状況 | 振る舞い |
|---|---|
| `/health` が 200 でない・つながらない | 接続失敗 (他の URL を試さない) |
| `/v1/models`・`/props` が 503 | 「Gufo はモデルを読み込み中」 と出して失敗 |
| `/v1/models` が取れない・`data` が無い | 何が取れなかったかを出して失敗 |
| `/props` の `n_ctx` が取れない | 何が取れなかったかを出して失敗 (`n_ctx_train`・モデル名から推測しない) |

起動時に `config.json` の `contextWindow` が無い時の解決 (`src/index.ts`) は、 他の種類と同じ規則に従う
(セットアップは必ず `contextWindow` を書くので、 Gufo では通常ここに来ない)。

## 4. 実装

- `src/providers/gufo.ts` (`GufoProvider`。 `OpenAICompatProvider` を継ぐ)
- `src/config/types.ts`: `ProviderType` に `"gufo"`、 `LOCAL_PROVIDER_TYPES`・`isLocalProvider` (ローカルの種類の一覧を 1 か所にする)、 `DEFAULT_PORTS`・`PROVIDER_LABELS`
- ローカルの種類を並べていた所 (`repl.ts`・`setup-wizard.ts`・`config-schema.ts`・`prewarm.ts`・`provider-factory.ts`) は `LOCAL_PROVIDER_TYPES` を使う
- テスト: `tests/providers/gufo.test.ts`

既に `llamacpp` で登録した Gufo はそのまま動く (自動で書き換えない)。 Gufo として使うなら `/models` → Add new で登録し直す。
