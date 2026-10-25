# 引き継ぎ書: コンテキスト整理の作り直し (2026-10-25)

> 次のチャットはこの文書から始める。 正本の設計は [context-reduction-redesign.md](context-reduction-redesign.md)。
> この文書は作業の状態と進め方の約束だけを書く (設計の中身は設計書を読む)。

## 1. ここまでに終わったこと (すべて main に push 済み)

| 内容 | コミット | 正本 |
|---|---|---|
| KV キャッシュが毎回全損していた不具合の修正 (日時・Goal・ToDo を履歴の前に置いていた → 末尾の未送信メッセージへ追記) | `1dce520` | [prompt-prefix-stability.md](prompt-prefix-stability.md) |
| 再発防止: 前方一致の不変条件テスト、 書き換え理由の申告と `prefix_break` ログ、 CLAUDE.md のルール | `28e4b9f` | 同上 §7 |
| `/run pause` の API 実行中カウント漏れの修正 | `30a0dd1` | [product-feature-comparison-cycle-17-run-api-pause-2026-09-02.md](product-feature-comparison-cycle-17-run-api-pause-2026-09-02.md) §8 |
| `/run pause` を「保存して止める」 1 方式に統合、 次回起動時の再開確認 | `af5d053` | [durable-run-resume-design.md](durable-run-resume-design.md) |
| 旧方式・別名の整理 T1〜T5 (コマンド別名削除、 `--resume latest`、 設定コマンドを対話画面に一本化、 権限を `security.rules` に一本化、 文書の最終確認) | `f72a56e` `34ea051` `69d0b54` `b1c67f0` `0e832bc` `33d4d9f` | [todo-legacy-ways-cleanup.md](todo-legacy-ways-cleanup.md) |
| コンテキスト整理の作り直しの **設計** (未実装) | `66da100` `5be15b9` | [context-reduction-redesign.md](context-reduction-redesign.md) |

実機の効果 (2026-10-25 myppt 再開後): キャッシュ再利用率は毎回 99% 以上 (再利用数 = 前回の入力 − 4)、
1 回の呼び出しは平均 約 28 分 → 約 1.5 分。 `prefix_break` は 0 件。

利用者の環境: myppt の作業は `0e832bc` 時点でビルドした exe で動いている (権限ルールの移行も適用済み)。

## 2. 次にやること: コンテキスト整理の実装

設計書 §13 の実装タスク 13 本を順に行う。 決定事項は §14.2、 実装中に決めてよい残りは §14.3。

要点 (詳細は設計書):
- 割合での発火を廃止。 予約 R (出力上限 O + ツール結果の合計上限 T + 余白) で「次の呼び出しが必ず入る」 を保証
  (強制) + 強い区切りでだけ先回り
- 1 回の整理イベントで、 片付け → 段階 0〜2 (機械的、 毎回最後まで) → 段階 3 (要約、 足りない時だけ) を写しに適用し、
  履歴の差し替えは 1 回だけ。 利用者の発言は原文のまま残す
- 要約はキャッシュ済みの並びの末尾に指示を足して呼ぶ (**思考オンのまま**。 オフにすると system 先頭が変わり全損する)
- 手動は `/compact` の 1 つだけ。 `/forget` 一式・区切りでの自動リセット・`config.context.reduction` 等は削除
- モデルに残量を伝えない (context anxiety 対策)
- 予熱 (依頼の境目・`/compact` 後・再開時)、 計測 (`reduction_event` / `cache_miss` / `side_call`)

関連: 補助呼び出し・サブエージェントによるキャッシュの追い出しは [todo-local-llm-speed.md](todo-local-llm-speed.md) T2/T3
(2 スロット起動の案は T6)。 計測 (T1) と依頼の区切りの書き換え (T4) は整理の設計書が担当。

## 3. 進め方の約束 (利用者と合意済み)

- タスクごとに **Opus のサブエージェントを 1 つずつ** 使う (並列にしない)。 メインはオーケストレーションと結果の確認
- 各タスクで `npx tsc --noEmit` / `npm run lint` (エラー 0) / `npm run test:coverage` / `npm run test:e2e` を通し、
  `npx biome format --write` してから main に直接コミット・push (ブランチを作らない、 `--no-verify` 禁止)
- コミット本文は `背景:` `変更:` `検証:` 必須 (commit-msg フック)。 末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- `npm audit` は main の時点で既存の指摘により失敗する (別件・未対応)。 タスクの合否には使わない
- `npm run build:deploy` は利用者が行う。 **実装の途中は利用者にビルドしないよう伝えてある** (途中の作業ツリーが exe に混ざるため)。
  全タスクが終わったら「ビルドしてよい」 と伝える
- 利用者の実データ (`~/.localllm`) はテストで触らない (一時ホームを使う)
- 利用者の原則: **同じことをする複数のやり方を残さない** (旧方式は削除。 互換レイヤー・別名を作らない)。
  **フォールバックや黙った欠損をしない** (失敗は見える形で報告)
- 前方一致の不変条件 (CLAUDE.md「プロンプトの前方一致を壊さない」) を守る。 整理イベントの書き換えは理由を申告する
- 会話は日本語。 説明は平易に (借用語・内輪の略語を避ける)

## 4. 未決・保留 (利用者の判断待ち)

- [todo-legacy-ways-cleanup.md](todo-legacy-ways-cleanup.md) の「未対応・要判断」 (`/quit` と `/exit` など)
- config の `mainLLM` 等と model-registry の二重管理 (C4、 今は触らない)
- `npm audit` の本番依存の high 指摘 (更新してよいか)
- TTY での実機確認がまだのもの: 起動時の再開確認の はい/いいえ、 `/permission` 画面
