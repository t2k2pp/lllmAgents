---
description: NanoClaw エージェント REPL を起動します — claude CLI を基盤とした永続的でセッション対応の AI アシスタントです。
---

# Claw コマンド

会話履歴をディスクに永続化し、オプションで ECC スキルコンテキストをロードするインタラクティブな AI エージェントセッションを開始します。

## 使い方

```bash
node scripts/claw.js
```

または npm 経由:

```bash
npm run claw
```

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `CLAW_SESSION` | `default` | セッション名（英数字 + ハイフン） |
| `CLAW_SKILLS` | *(空)* | システムコンテキストとしてロードするスキル名のカンマ区切りリスト |

## REPL コマンド

REPL 内で、プロンプトに直接以下のコマンドを入力します:

```
/clear      現在のセッション履歴をクリア
/history    会話履歴全体を表示
/sessions   保存済みのすべてのセッションを一覧表示
/help       利用可能なコマンドを表示
exit        REPL を終了
```

## 仕組み

1. `CLAW_SESSION` 環境変数を読み取り、名前付きセッションを選択します（デフォルト: `default`）
2. `~/.claude/claw/{session}.md` から会話履歴をロードします
3. オプションで `CLAW_SKILLS` 環境変数から ECC スキルコンテキストをロードします
4. ブロッキングプロンプトループに入ります — 各ユーザーメッセージは完全な履歴と共に `claude -p` に送信されます
5. レスポンスはセッションファイルに追記され、再起動後も永続化されます

## セッションストレージ

セッションは `~/.claude/claw/` に Markdown ファイルとして保存されます:

```
~/.claude/claw/default.md
~/.claude/claw/my-project.md
```

各ターンは以下の形式でフォーマットされます:

```markdown
### [2025-01-15T10:30:00.000Z] User
What does this function do?
---
### [2025-01-15T10:30:05.000Z] Assistant
This function calculates...
---
```

## 使用例

```bash
# デフォルトセッションを開始
node scripts/claw.js

# 名前付きセッション
CLAW_SESSION=my-project node scripts/claw.js

# スキルコンテキスト付き
CLAW_SKILLS=tdd-workflow,security-review node scripts/claw.js
```
