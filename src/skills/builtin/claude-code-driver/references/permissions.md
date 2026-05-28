# permissions.md — 権限ダイアログの自動応答

## 大原則

**人間が見ていない状況での全自動 "Yes" は危険**。 claude は強力な編集権限を持つので、
本スキルはデフォルトで「権限ダイアログ = deny」 を選ぶ安全側設計になっている。

書き込み/実行系の許可を含めて全自動で走らせたい場合は、 expect で `y` を返すのではなく
**claude 側の `--permission-mode acceptEdits` または `bypassPermissions` を使う** こと。
expect の自動応答に頼るより、 claude 側で permission モデルを切り替える方が一貫性が高い。

## claude の権限モード (起動時フラグ)

| モード | 挙動 |
|--------|------|
| `default` | edit/bash 等で都度確認ダイアログ |
| `acceptEdits` | edit 系は確認なし、 危険コマンドのみ確認 |
| `bypassPermissions` | 全ての確認を skip (危険) |
| `plan` | 読み取り専用。 書き込み・実行を一切しない |

例: `expect drive-claude.exp --prompt "/ultrareview" -- --permission-mode plan`

→ `--` 以降は claude にそのまま渡る。

## 権限ダイアログの実物 (claude 2.x 系で確認したパターン)

claude のバージョンで UI 文言は変わる。 2026-05 時点で expect script が見ているパターン:

```
Do you want to proceed?
[1] Yes
[2] Yes, and don't ask again for ...
[3] (なし or プロジェクトレベル許可)
[4] No, tell Claude what to do differently
```

または yes/no 二択:

```
Do you want to edit src/foo.ts? [y/N]
```

drive-claude.exp はこれらを検出すると:

- `--auto-deny`: 即 `n` または `4` を送信して exit 3
- `--auto-yes-readonly`: 現状は安全側で `n`/`4` を送信 (理由は後述)
- どちらも指定なし: `n`/`4` を送信して継続 (= 安全側)

## なぜ `--auto-yes-readonly` が現状「安全側」 なのか

ダイアログのテキストだけからは「これは読み取りか書き込みか」 が確実に判別できないため。
pattern マッチの誤判定で書き込みを許してしまうと、 user のリポジトリを破壊する危険がある。

「読み取りは許可したい」 が真意なら、 expect で `y` を返すのではなく
`claude --permission-mode plan` で起動するのが正しい (Plan モードは読み取り専用)。

## 安全な使い分けレシピ

| やりたいこと | 推奨設定 |
|-------------|----------|
| 純粋な調査・レビュー (`/ultrareview`, `/code-review`) | `-- --permission-mode plan` |
| 自動でコミットまでやらせたい | `-- --permission-mode acceptEdits` (ただし user 同席推奨) |
| 完全放置で実行 | `-- --permission-mode bypassPermissions` (非推奨。 user 明示同意必須) |
| 何が許可されるか毎回見たい | デフォルト + user が別端末で claude 操作 |

## バージョンアップで pattern が壊れたとき

drive-claude.exp の `expect -re {...}` の正規表現群を更新する。 更新時は:

1. 該当 claude バージョン (`claude --version`) を本ファイルに追記
2. 新しい pattern と古い pattern を併記 (旧 claude を使う user のため)
3. docs/claude-code-driver-skill.md の §6 (制約) にも追記

### 観測されたパターン履歴

| claude version | プロンプト記号 | 権限ダイアログ |
|----------------|----------------|----------------|
| 2.1.152 (2026-05 確認) | `│ >` | `Do you want to ... [1] [2] [4]` 形式 |
