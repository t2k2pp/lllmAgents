---
name: dev-workflow
description: 開発ワークフロー戦略。実装・修正・リファクタリング等のコーディング作業を行う際に使用する。ツール選択の原則、マルチファイルプロジェクトの作成手順、エラー回復の戦略を定義する。
---

# Development Workflow

## ツール選択の原則
- ファイル内容の確認には file_read を使う。bash (cat/type/head) は使わない
- file_edit が失敗したら file_read で現在の内容を確認し正しい old_string で再試行する。2回失敗したら file_write でファイル全体を書き直す
- 新規ファイル作成は file_write を使う。コードをテキスト応答に書かない
- bash は git bash 構文で書く（cmd.exe/PowerShell 構文は不可）

## マルチファイルプロジェクト作成
1. ファイル一覧と依存関係を整理する（todo_write で管理）
2. 依存される側から順に作成する（定数/型定義 → ユーティリティ → コアロジック → UI → エントリポイント）
3. 各ファイルの export/インターフェースを意識し、呼び出し側と整合性を保つ
4. 独立した複数ファイルは1回のレスポンスで並列に file_write する
5. 全ファイル作成後、エントリポイントの import/参照を file_read で検証する

## エラー回復
- 同じ操作が2回失敗したら別のアプローチに切り替える（繰り返さない）
- file_edit 連続失敗 → file_write で全体書き直し
- bash エラー → エラーメッセージを読んで修正。認識されないコマンドなら file_read 等の専用ツールに切り替える

## 実装→検証サイクル
実装(file_write/edit) → 検証(bash) → エラー修正 → 再検証。省略禁止。
- JS/TS: `node --check <file>`
- Python: `python -c "import ast; ast.parse(open('<file>').read())"`
- 汎用: build/test/lint
