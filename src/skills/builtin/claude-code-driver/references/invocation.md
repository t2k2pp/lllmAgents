# invocation.md — claude の呼び出し方早見表

## TTY (本スキル) vs `-p` (headless) の使い分け

| ケース | 推奨経路 | 理由 |
|--------|----------|------|
| 1-shot で完結し、 副作用が小さい | `claude -p "..."` | 軽い・シンプル |
| 1-shot だが claude スラッシュコマンドを呼ぶ | TTY (本スキル) | -p では一部スラッシュコマンドが動かない |
| 多ターンで続けたい | TTY (本スキル) | プロセス継続でコンテキストを保持 |
| ストリーミング JSON を機械処理したい | `claude -p --output-format stream-json` | パース容易 |
| Plan モードを使いたい | TTY (本スキル) | -p では Plan が完結しない |
| 完全自動化で permission を全許可したい | `claude -p --permission-mode acceptEdits` | TTY だと permission ダイアログを毎回拾う必要 |
| subscription を消費したくない (テスト) | `claude --version` 等の副作用なしコマンド | どちらでも良いが TTY なら本スキルの動作確認に流用可 |

## claude CLI のよく使うフラグ

| フラグ | 用途 |
|--------|------|
| `-p "<prompt>"` | headless モード (1-shot) |
| `--output-format text` (default) | テキストのみ出力 |
| `--output-format json` | JSON 出力 (`{"result": "...", ...}`) |
| `--output-format stream-json` | line-delimited JSON ストリーム |
| `--verbose` | stream-json と組み合わせて詳細イベントを得る |
| `--model <id>` | モデル指定 (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`) |
| `--resume <session-id>` | 前回セッション再開 |
| `--continue` | 直近セッションを再開 |
| `--permission-mode <mode>` | `default` / `acceptEdits` / `bypassPermissions` / `plan` |
| `--disallowedTools "*"` | 全 tool 無効化 (純粋なテキスト生成器として使う) |
| `--allowedTools "..."` | 許可 tool を絞る |
| `--add-dir <path>` | 作業ディレクトリを追加 |

## headless で済む典型例 (TTY 不要)

```bash
# (1) 一発で関数を生成
claude -p "TypeScript で fibonacci の純関数を書いて" --output-format text

# (2) JSON で結果を取得
claude -p "package.json の name と version を JSON で返して" \
  --output-format json | jq .result

# (3) 全 tool 無効でテキスト生成のみ
claude -p "このエラー何が原因? <log>" \
  --disallowedTools "*" --output-format text
```

## TTY (本スキル) でなければ厳しい例

- `/ultrareview` を走らせ、 途中で出る permission を握りつぶしながら完走させたい
- Plan モードに入り、 plan を確認して accept してから実行に移したい
- 同じセッションで「最初にざっくり調査 → ヒアリング → 実装」 と 3 ターン回したい
- claude 側の対話 UI (TODO リストの差分表示等) を見たい / ログに残したい

## bash ツール経由で叩くときの注意

- lllmAgents の bash ツールは 120 秒で timeout する。 expect 側の `--timeout` は
  この範囲外で長く取れるが、 結局 bash ツール側で打ち切られる
  → 長時間タスクは `run_in_background: true` を使うか、 expect script を nohup で
  バックグラウンド化して PID と log path を返し、 後で `tail` で結果回収する設計が必要
- CWD は呼び出し元 (lllmAgents) の現在 CWD を引き継ぐ。 別プロジェクトで動かしたい
  場合は `bash -lc "cd /path && expect ..."` の形にする
