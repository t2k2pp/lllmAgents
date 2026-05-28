# claude-code-driver スキル設計書

lllmAgents 内のメインLLM が、Claude Code CLI (`claude`) を **対話TTY (PTY)** で
駆動して「下請けエージェント」として活用するためのスキル。

## 1. 目的・前提

### 1.1 何を実現するか

lllmAgents が動くプロセスから、別プロセスの Claude Code CLI を以下のように扱う:

- **対話セッションを開始**: `expect` で PTY を割り当てて `claude` を spawn
- **多ターンのやり取り**: プロンプト送信 → 応答待ち → 次プロンプト送信 を繰り返し
- **スラッシュコマンド利用**: `/ultrareview`, `/commit` 等 claude 内蔵スキルを呼ぶ
- **権限ダイアログ自動応答**: `y/n` ・許可レベル数値 (1/2/4/5) の自動入力
- **セッション継続**: `claude --resume <id>` で前回続きから再開
- **ログ回収**: 最終出力 (assistant の最後の発話) を取得して呼び出し側に返す

### 1.2 なぜ `claude -p` (headless) ではなく TTY か

| 観点 | `claude -p` headless | TTY (本スキル) |
|------|----------------------|----------------|
| 1-shot 単発タスク | ◎ 簡単 | ○ オーバーヘッドあり |
| 多ターン対話 | △ `--continue` でも複数プロセス | ◎ 1 プロセスで連続 |
| スラッシュコマンド | △ 限定的 | ◎ フル利用可能 |
| 権限ダイアログ | △ `--permission-mode` で迂回 | ◎ 都度応答可能 |
| Plan モード | × | ◎ |
| 実装コスト | 低 | 中 (expect 必須) |

本スキルは TTY 経路を主軸にし、headless 経路は references で補足する位置づけ。

### 1.3 対象読み手 (LLM)

- ローカルLLM (gpt-oss-120b, qwen3:32b 等) と クラウドLLM (Anthropic API 直叩き等) の両方
- ローカル向けには具体例を厚めに、クラウド向けにはフラグ早見表とトラブル対応を厚めに
  references/ に分離する

## 2. トリガー条件 (description に書く内容)

- ユーザーが「Claude (Code) に〜させて」「claude に頼んで」と明示した時
- ローカルLLM の能力外と判断する重い知的タスク (深いリファクタ、 全体俯瞰、 セキュリティ
  レビュー) を下請けに出したい時
- claude 側の組み込みスキル (`/ultrareview` 等) を使いたい時

## 3. ファイル構成

```
src/skills/builtin/claude-code-driver/
├── SKILL.md                  # frontmatter + 本体 (~150 行)
├── scripts/
│   └── drive-claude.exp      # expect 駆動スクリプト (実行可能)
└── references/
    ├── invocation.md         # -p vs TTY、フラグ早見表
    ├── multiturn.md          # --resume / --continue / セッションID
    ├── permissions.md        # 権限ダイアログ自動応答パターン
    ├── slash-commands.md     # claude 側スラッシュコマンド早見表
    └── troubleshooting.md    # 認証切れ / CWD / タイムアウト / ANSI
```

合計予定行数: SKILL.md 150 行、references 各 50-100 行、scripts 1 本 ~150 行。

## 4. 中核アーキテクチャ: expect 駆動

### 4.1 起動形

```bash
expect <skill_dir>/scripts/drive-claude.exp \
  --prompt "<最初のプロンプト>" \
  --timeout 300 \
  --auto-yes-readonly \
  --resume <session-id>?
```

stdout に Claude の最終応答テキスト (ANSI 除去後) を吐く。終了コード:
- 0: 正常終了
- 1: タイムアウト
- 2: 認証エラー (Please login)
- 3: 権限ダイアログで拒否選択した
- 99: 想定外のエラー

### 4.2 expect script のフロー

1. `spawn claude $args` で PTY 内に claude を起動
2. プロンプト記号 (デフォルトでは `│ >` 等) が出るまで `expect` 待機
3. 引数で指定された prompt を `send` (`\r` 終端)
4. 応答ストリームを読みつつ:
   - 権限ダイアログ (`y/n`, `[1] Yes [2] Always allow ...`) を検出 → `--auto-yes-readonly`
     等のポリシーに従って応答
   - エラー pattern (`Error: ...`, `Please login`) を検出 → 該当終了コードで exit
5. 再度プロンプト記号が出るまで読み続ける
6. プロンプト記号到達 → そこまでの出力からアシスタント本文を抽出して stdout に出力
7. multiturn モードなら stdin から次プロンプトを読んで step 3 に戻る
8. EOF or `--quit-after-response` → `/quit` 送信して終了

### 4.3 ローカルLLM 視点の典型呼び出し

```
ユーザー: 「このリポジトリを claude にレビューしてもらって」
↓
ローカルLLM が `/claude-code-driver` を発火
↓
SKILL.md の手順に従い bash ツールで:
  bash -lc "expect ~/.localllm/skills/claude-code-driver/scripts/drive-claude.exp \
    --prompt '/ultrareview' --auto-yes-readonly --timeout 600"
↓
expect script が claude を起動 → /ultrareview 実行 → 完了応答取得
↓
ローカルLLM が結果をユーザーに整形して返す
```

## 5. 既存資産との関係

| 既存資産 | 関係 |
|----------|------|
| `src/providers/claude-cli.ts` | 別経路。 claude-cli プロバイダはメイン/セカンドLLM として claude を使う (= lllmAgents 自体が claude にプロキシ)。 本スキルは「メインLLM が claude に下請けを出す」 という別の使い方を担う。 競合しないので両立可能 |
| `bash` ツール (`src/tools/definitions/bash.ts`) | スキルが利用する実行経路。 120 秒タイムアウトに引っかからないよう、 長時間呼び出しは別途 timeout 制御 (expect 側) |
| `second_llm` ツール | 似た用途だが、 second_llm は lllmAgents の type システムで委譲するためトークン経由。 本スキルは subprocess なので Claude 側の対話機能 (slash command 等) もそのまま使える点で差別化 |
| `scripts/sync-skills.js` | 同期対象に自動的に含まれる (`src/skills/builtin/*` 全体が対象) |

## 6. 制約・運用上の注意

- **subscription / API key 消費**: claude CLI が認証済み subscription を消費する。 過度な
  ループ実行は避ける。 references/troubleshooting.md に明記
- **CWD 継承**: claude は起動時の CWD をプロジェクトとして扱う。 lllmAgents の bash ツール
  経由なら現在 CWD が引き継がれる
- **ANSI / カーソル制御**: TTY 出力に ANSI エスケープが大量に含まれる。 expect 内で
  正規表現フィルタを噛ませる
- **権限ダイアログのフォーマット変化**: claude のバージョン更新で UI 文言が変わる可能性。
  pattern を references/permissions.md にバージョン (テスト時) と共に記録
- **non-TTY (パイプ) モードでは動かない**: lllmagents-test スキルがやっているような
  pipe 入力テストでは PTY が割り当てられず本スキルは機能しない。 SKILL.md で明記
- **コスト**: 1 回の `/ultrareview` 等は数 USD オーダー消費する可能性あり。 不用意に
  ループに組まないこと

## 7. テスト方針

実装段階で以下を確認:

1. `expect drive-claude.exp --prompt '/version'` 等の **副作用なし最小コマンド** で起動
   → 終了までを通すことで基本フローを確認 (subscription はほぼ消費しない)
2. 認証切れシミュレート (環境変数で claude credential path を空にする) → 終了コード 2 確認
3. タイムアウト指定 1 秒 → 終了コード 1 確認

`/ultrareview` 等の本格コマンドの動作確認は user が手動で行う前提とする
(自動で何度も叩くと subscription 消費が問題になるため)。

## 8. 実装と本書の整合性ルール (CLAUDE.md 準拠)

- expect script の引数仕様を変更したら本書 §4.1 を更新
- 終了コードを変更したら本書 §4.1 を更新
- references/ の構成を変えたら本書 §3 を更新
- 新しい claude バージョンで pattern が変わったら references/permissions.md の記録を更新
