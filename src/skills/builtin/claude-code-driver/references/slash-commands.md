# slash-commands.md — claude 側スラッシュコマンド早見表

本スキルから claude を駆動する際に、 `--prompt "/command"` 形で送ることで claude の
組み込みスキル/コマンドを利用できる。 ここでは lllmAgents から委譲する価値が大きい
ものに絞って列挙する。

claude 側の完全な一覧は claude 内で `/help` を叩いて取得するのが確実。

## 重い分析系 (lllmAgents から委譲する価値が高い)

| コマンド | 用途 | 想定コスト |
|----------|------|-----------|
| `/ultrareview` | リポジトリ全体のマルチエージェント深掘りレビュー | 高 (数 USD オーダー、 数分〜10分超) |
| `/review` | PR / 任意ファイルのコードレビュー | 中 |
| `/security-review` | セキュリティレビュー (脆弱性スキャン視点) | 中 |
| `/init` | CLAUDE.md の初期生成 (プロジェクト onboarding) | 中 |

## 開発系

| コマンド | 用途 |
|----------|------|
| `/verify` | 変更を実機で動かして確認 |
| `/run` | アプリを起動して動作確認 |
| `/code-review` | 現在の diff のレビュー |

## メタ・設定系 (基本 lllmAgents から触らない)

| コマンド | 備考 |
|----------|------|
| `/help` | コマンド一覧 |
| `/config` | claude 自身の設定変更 (user が直接やるべき) |
| `/clear` | 会話履歴クリア |
| `/quit` | 終了 (drive-claude.exp が最後に送る) |

## 委譲時の prompt 設計

スラッシュコマンドは引数を取れる場合がある。 ` ` (スペース) で区切って渡せばよい:

```bash
expect drive-claude.exp --prompt "/review PR#42" --quit-after-response
expect drive-claude.exp --prompt "/code-review --comment" --quit-after-response
```

注意: 重いコマンド (`/ultrareview`) は完了まで 10 分以上かかる。 `--timeout` を
最低 1800 秒、 lllmAgents の bash ツール経由なら `run_in_background: true` で
非同期化して PID と log path だけ user に返す運用が現実的。

## lllmAgents のスキルと claude のスキルの対応関係

| lllmAgents 側 | claude 側 | 使い分け |
|---------------|-----------|---------|
| `/code-review` | `/code-review`, `/review` | 同名でも実装が違う。 lllmAgents 側は軽量、 claude 側は重量級 |
| `/pr-review` | `/review` (PR 指定) | claude 側は GitHub と統合可能 |
| `/commit` | (なし。 user が claude に "コミットして" と指示) | コミットは lllmAgents 側で十分 |
| (なし) | `/ultrareview` | 重量級レビューは claude 委譲一択 |

「軽い処理は lllmAgents、 深い処理は claude 委譲」 が基本方針。
