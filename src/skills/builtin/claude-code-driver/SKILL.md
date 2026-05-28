---
name: claude-code-driver
description: lllmAgents のメインLLM が、 別プロセスの Claude Code CLI (`claude`) を 対話TTY (PTY) で駆動して下請けエージェントとして使うためのスキル。 ユーザーが「claude にやらせて」 と明示した時、 または ローカルLLM の能力を超える深い推論・大規模リファクタ・ `/ultrareview` 等の claude 側スラッシュコマンド利用が必要なときに使う。 expect で PTY を割り当てるので非TTY (パイプ) モードでは機能しない。 subscription / API key を消費する点に注意。
---

# claude-code-driver

このスキルは、lllmAgents 内で動いている LLM (ローカル/クラウド問わず) が、
別プロセスの **Claude Code CLI** を `expect` で対話TTY 駆動して
下請けタスクを委譲するためのワークフローを提供する。

設計の全体像は **docs/claude-code-driver-skill.md** 参照。

## いつ使うか

- ユーザーが「claude にやらせて」「Claude Code に頼んで」 と明示した
- ローカルLLM の能力を超える知的タスク (例: 大規模リファクタ、 全体俯瞰の設計レビュー、
  `/ultrareview` のような重い claude 内蔵スキル) を下請けに出す判断をした
- 多ターン対話で claude を使い続けたい (1-shot なら `claude -p` でも良いが、
  対話を続けるなら本スキル経由)

**使わないほうがいい場面**:

- 単発で済む簡単な質問 → 自分で答える
- 副作用なしの 1-shot コード生成 → `bash` で `claude -p "..."` 直接呼びでも十分
- 非TTY (パイプ) モードで lllmAgents が動いている → PTY が無く本スキルは機能しない

## 前提条件チェック

1. `claude --version` が通る (PATH に `claude` バイナリ)
2. `expect --version` が通る (macOS は標準、 Linux は `apt install expect` 等)
3. `claude login` 済み (subscription または API key が設定されている)
4. lllmAgents が **TTY モード** で動いている (`npm run start` を端末から起動)

不足があれば user に伝えて中断する。 ローカル環境を勝手に変更しない。

## 基本フロー

```
1. ユーザー意図を確認 (任意で AskUser)
   ↳ どんな指示を claude に渡すか、 多ターンか単発か
2. bash ツールで expect script を起動
   ↳ scripts/drive-claude.exp に prompt / timeout / 権限ポリシーを引数で渡す
3. stdout から claude の応答を回収
   ↳ "----- TURN END -----" 区切り
4. 必要なら追加 prompt を stdin に流して多ターン継続
5. 終了コードで成否を判定
   ↳ 0=正常, 1=timeout, 2=auth error, 3=permission denied, 4=arg error, 99=その他
6. 結果を整形してユーザーに返す
```

## 呼び出し例

### 例 A: 単発タスクをクワイト後終了

```bash
bash -lc 'expect ~/.localllm/skills/claude-code-driver/scripts/drive-claude.exp \
  --prompt "src/foo.ts の関数 bar を 純関数に refactor して。 テストも書いて。" \
  --timeout 600 \
  --quit-after-response'
```

### 例 B: スラッシュコマンドを叩く (リポジトリ全体レビュー)

```bash
bash -lc 'expect ~/.localllm/skills/claude-code-driver/scripts/drive-claude.exp \
  --prompt "/ultrareview" \
  --timeout 1800 \
  --quit-after-response'
```

### 例 C: 前回セッションの続きから

```bash
bash -lc 'expect ~/.localllm/skills/claude-code-driver/scripts/drive-claude.exp \
  --resume <session-id> \
  --prompt "さっきの続きで、 テストも書いて" \
  --quit-after-response'
```

### 例 D: 多ターン (stdin から追加プロンプト)

```bash
bash -lc 'expect ~/.localllm/skills/claude-code-driver/scripts/drive-claude.exp \
  --prompt "プロジェクトの概要を教えて" \
  --timeout 600 <<EOF
次にアーキテクチャ図を ASCII で描いて
それを docs/arch.md に保存して
/__quit__
EOF'
```

## 引数早見表

| 引数 | 用途 |
|------|------|
| `--prompt "<text>"` | 起動直後に送る最初のプロンプト (任意) |
| `--timeout <sec>` | 1 ターンあたりのタイムアウト秒数 (デフォルト 300) |
| `--resume <id>` | 前回セッションを再開 (claude --resume と同じ) |
| `--quit-after-response` | 最初の応答取得後に `/quit` |
| `--auto-yes-readonly` | 読み取り系の権限ダイアログを許可 (現状は安全側で deny 動作) |
| `--auto-deny` | 全権限ダイアログを拒否 |
| `--bin <path>` | claude バイナリのパス (デフォルト PATH 検索) |
| `-- <args>` | 以降を claude にそのまま渡す (例: `-- --model claude-opus-4-7`) |

詳細は **references/invocation.md** 参照。

## 終了コードの扱い

- `0` → 正常応答。 stdout を user に整形して返す
- `1` → タイムアウト。 `--timeout` を伸ばすか、 タスク分割を検討
- `2` → 認証エラー。 user に `claude login` を促す。 自動で login コマンドは叩かない
- `3` → 権限ダイアログで deny した。 別アプローチを検討、 または user に手動 claude 実行を提案
- `4` → 引数ミス。 スキル内のバグ。 修正対象
- `99` → 想定外。 stderr ログを user に提示

## 重要な注意

- **subscription / API key 消費**: 不用意にループ呼び出ししない。 `/loop` と組み合わせる
  際は特に慎重に
- **権限ダイアログは安全側に倒す**: 現状の expect script は権限プロンプトに `n` を返す。
  本当に書き込み許可が必要なら、 user に `claude` を別端末で手動起動してもらう運用を推奨
- **非TTY 環境では動かない**: `lllmagents-test` のように pipe 入力でテストしているとき
  本スキルは PTY が無く失敗する。 SKILL 発火前にチェック
- **CWD 継承**: claude は起動時の CWD をプロジェクトとして扱う。 bash ツール経由なら
  現在 CWD が引き継がれる
- **claude のバージョン互換**: UI 文言 (プロンプト記号、 権限ダイアログ) が変わると
  pattern マッチが破綻する。 破綻時は **references/troubleshooting.md** と
  scripts/drive-claude.exp の pattern を更新する

## さらに詳しく

| 知りたいこと | 参照先 |
|--------------|--------|
| -p (headless) との使い分け・フラグ早見表 | references/invocation.md |
| 多ターンの実装パターン・セッションID 管理 | references/multiturn.md |
| 権限ダイアログのフォーマットと自動応答 | references/permissions.md |
| claude 側スラッシュコマンドの早見表 | references/slash-commands.md |
| 認証切れ・CWD・タイムアウト・ANSI 処理 | references/troubleshooting.md |
