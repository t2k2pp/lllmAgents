---
name: dev-workflow
description: 既存 lllmAgents コードベースに手を入れる時の作業原則。 ユーザーが既存ファイルの修正・機能追加・バグ修正・小規模リファクタを依頼した時に使用する。 ツール選択の原則、 エラー回復戦略、 実装→検証サイクルを定義。 ゼロからの新規プロジェクトは `/project`、 大規模リファクタは `/refactoring`、 テスト先行は `/tdd` を使う。
---

# Dev Workflow (既存コードを触る時の作法)

`/project` が「ゼロから立ち上げ」 専用なのに対し、 本スキルは **既存リポジトリで日常的にコードを編集する時の原則** を定める。

## ツール選択の原則

| やりたいこと | 使うもの | 使ってはいけないもの |
|-------------|---------|------------------|
| ファイル内容を読む | `file_read` | bash の `cat` / `head` / `tail` |
| ファイルの一部を変更 | `file_edit` | bash の `sed` / `awk` |
| 新規ファイル作成 / 全体書き直し | `file_write` | テキスト応答にコード貼り付け |
| パターン検索 | `glob` (パス) / `grep` (内容) | bash の `find` (遅い・出力が冗長) |
| ToDo 管理 | `todo_write` | テキスト応答の箇条書きで管理 |
| 構文チェック | `bash node --check` 等 | LLM の目視チェックだけ |

`bash` は git / npm / 構文チェック等で使うが、 ファイル操作には使わない。

## 実装→検証サイクル

**省略禁止**。 各実装の直後に検証を回す。

```
file_write / file_edit
  ↓
構文チェック (file 単位)
  - JS/TS: node --check <file>
  - Python: python -c "import ast; ast.parse(open('<file>').read())"
  ↓
プロジェクト検証 (関連範囲)
  - npm run lint       (型チェック、 速い)
  - npm test -- <対象>  (関連テストだけ)
  ↓
エラー → 修正 → 再検証
```

**最後にまとめて検証ではなく、 各ステップごとに検証** する。

## エラー回復戦略

| 状況 | 対処 |
|------|------|
| 同じ操作が 2 回失敗 | 別アプローチに切り替え。 3 回目を繰り返さない |
| `file_edit` 連続失敗 | `file_read` で現状確認 → 正しい old_string で再試行 → それでも失敗なら `file_write` で全体書き直し |
| bash コマンドが unknown | 専用ツール (file_read 等) に切り替え。 PowerShell/cmd 構文を使っていないか確認 |
| 型エラーが連鎖 | 1 箇所ずつ直す。 同時に複数直さない (どの修正が効いたか不明になる) |

詳細なビルド系エラーは **`/build-fix`** を参照。

## CLAUDE.md 準拠の振る舞い

- **絶対パスを使う** (アプリ内のファイルアクセスは相対パス禁止)
- **設計書と実装の整合を保つ** — 機能追加なら `docs/<feature>-design.md` を同時更新
- **タスクは ToDo 化** — 概要レベルの設計思想も含めて構造化
- **参考資料と成果物を区別** — 動作検証物は `sandbox/`、 リポジトリルートに置かない

## このプロジェクト固有の罠 (永続メモリ + 観測値)

| 罠 | 対処 |
|----|------|
| `import X from "../foo"` (拡張子なし) | ESM の制約で `.js` 必須。 TypeScript でも `.js` と書く |
| `jest.fn()` を書いてしまう | vitest 環境なので `vi.fn()` / `vi.mock()` |
| `npm run build:exe` だけ実行して deploy/ が古い | 常に `npm run build:deploy` 経由 |
| 推測でエラー原因を断定 (永続メモリ: `feedback_diagnose_before_speculate`) | `git ls-files` / 実ログ / 再現テストで確認してから手を動かす |
| llama.cpp の `-c × --parallel` 関係を独断で変更 (永続メモリ: `feedback_llamacpp_parallel_ctx`) | 合意済み並列数を維持、 `/props` の n_ctx で検証 |

## 作業終了時のチェック

1. `npm run lint` 緑
2. `npm test` 緑 (関連範囲)
3. 変更内容に応じて設計書を更新したか
4. user の依頼スコープを超えていないか (memory: 過剰実装しない)
5. push 判断 (`/commit` を参照)

## 関連スキル

| スキル | 使い分け |
|--------|---------|
| `/project` | ゼロから新規プロジェクト立ち上げ |
| `/refactoring` | 大規模変更・機能廃止 (grep 影響範囲調査必須) |
| `/tdd` | テストを先に書きたい時 |
| `/build-fix` | ビルド/型/テストが落ちている時 |
| `/commit` | 一区切り着いたコミット〜push |
| `/code-review` | 自分で書いたコードの品質チェック |
